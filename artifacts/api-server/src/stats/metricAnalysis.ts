/**
 * Which entry conditions separate winners from stops (AltBullet indicator
 * relations). Every snapshot metric of closed trades is split into buckets:
 * numbers into quartiles, flags and labels by value. Per bucket: trades,
 * CAB win rate, average R and % — so a real entry filter can be chosen from
 * data, not from a cap on the number of signals.
 */
import { tradeStatus, type JournalRow } from "./journal";

export type AnalysisRow = JournalRow & { metrics: Record<string, unknown> | null };
export type Bucket = { label: string; lo?: number; hi?: number; n: number; winRate: number | null; avgR: number | null; avgPnl: number | null; sumR: number };
export type MetricAnalysis = { key: string; kind: "number" | "label"; n: number; buckets: Bucket[]; spreadR: number | null };

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function bucketStats(label: string, rows: AnalysisRow[], extra: Partial<Bucket> = {}): Bucket {
  const st = rows.map(tradeStatus);
  const wins = st.filter((s) => s === "profit" || s === "be_stop").length;
  const stops = st.filter((s) => s === "stop_loss").length;
  const rs = rows.map((r) => Number(r.r_multiple ?? 0));
  const ps = rows.map((r) => Number(r.pnl_pct ?? 0));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    label, ...extra, n: rows.length,
    winRate: wins + stops ? Math.round((wins / (wins + stops)) * 100) : null,
    avgR: rows.length ? round(sum(rs) / rows.length) : null,
    avgPnl: rows.length ? round(sum(ps) / rows.length) : null,
    sumR: round(sum(rs)),
  };
}

export function analyzeMetrics(all: AnalysisRow[], minPerBucket = 3): MetricAnalysis[] {
  const rows = all.filter((r) => r.status === "closed" && r.metrics);
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.metrics!)) keys.add(k);
  const out: MetricAnalysis[] = [];
  for (const key of [...keys].sort()) {
    const withValue = rows.filter((r) => r.metrics![key] !== null && r.metrics![key] !== undefined);
    if (withValue.length < minPerBucket * 2) continue;
    const sample = withValue[0].metrics![key];
    let buckets: Bucket[] = [];
    let kind: MetricAnalysis["kind"] = "label";
    if (typeof sample === "number" && !["hour_utc", "weekday_utc"].includes(key)) {
      kind = "number";
      const sorted = [...withValue].sort((a, b) => Number(a.metrics![key]) - Number(b.metrics![key]));
      const parts = Math.min(4, Math.floor(sorted.length / minPerBucket));
      for (let i = 0; i < parts; i++) {
        const part = sorted.slice(Math.floor((i * sorted.length) / parts), Math.floor(((i + 1) * sorted.length) / parts));
        const lo = Number(part[0].metrics![key]); const hi = Number(part[part.length - 1].metrics![key]);
        buckets.push(bucketStats(`${round(lo)} … ${round(hi)}`, part, { lo, hi }));
      }
    } else {
      const groups = new Map<string, AnalysisRow[]>();
      for (const r of withValue) {
        const v = String(r.metrics![key]);
        groups.set(v, [...(groups.get(v) ?? []), r]);
      }
      buckets = [...groups].filter(([, g]) => g.length >= minPerBucket)
        .sort((a, b) => b[1].length - a[1].length).map(([label, g]) => bucketStats(label, g));
    }
    if (buckets.length < 2) continue;
    const rs = buckets.map((b) => b.avgR).filter((v): v is number => v !== null);
    out.push({ key, kind, n: withValue.length, buckets, spreadR: rs.length ? round(Math.max(...rs) - Math.min(...rs)) : null });
  }
  return out.sort((a, b) => (b.spreadR ?? 0) - (a.spreadR ?? 0));
}
