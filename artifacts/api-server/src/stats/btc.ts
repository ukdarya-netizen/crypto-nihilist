/**
 * BTC tab (owner 2026-11-13, as the CAB «BTC» page): Bitcoin and its dominance (BTC.D) as the market context of
 * Nihilist's altcoin trades — observational, nothing here feeds the scanner.
 *  · now: BTC price and 24h change (BingX via CoinGlass, the 30m bars Nihilist already keeps), BTC.D and its
 *    1-day / 7-day change (CoinGlass /api/index/bitcoin-dominance, daily, cached 1 h);
 *  · by day (UTC, last 30): BTC close and change, BTC.D and its change, our signals opened, trades closed and
 *    their result, stops;
 *  · our closed trades by BTC 24h at the entry (from the entry snapshot) and by the day's BTC.D + BTC direction
 *    (the CAB cheatsheet's six scenarios, filled with our real results), longs and shorts apart.
 */
import { cgRequest } from "../market/coinglass";
import { book } from "../market/candleStore";
import { summarize, type JournalRow } from "./journal";

export const BTC = "BTC-USDT";
const DAY = 86_400_000;

export type DominancePoint = { t: number; dominance: number; price: number | null };

export function parseDominance(data: unknown): DominancePoint[] {
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((r: Record<string, unknown>) => {
      const raw = Number(r.timestamp ?? r.time ?? r.t);
      const t = raw < 10_000_000_000 ? raw * 1000 : raw;
      const dominance = Number(r.bitcoin_dominance ?? r.dominance);
      const price = Number(r.price);
      return { t, dominance, price: Number.isFinite(price) && price > 0 ? price : null };
    })
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.dominance) && p.dominance > 0 && p.dominance < 100)
    .sort((a, b) => a.t - b.t);
}

let cache: { at: number; points: DominancePoint[] } | null = null;
export async function dominanceHistory(now = Date.now()): Promise<DominancePoint[]> {
  if (cache && now - cache.at < 3_600_000 && cache.points.length) return cache.points;
  const r = await cgRequest("/api/index/bitcoin-dominance", {}, { health: false });
  const points = r.ok ? parseDominance(r.data) : [];
  if (points.length || !cache) cache = { at: now, points };
  else cache.at = now - 3_600_000 + 5 * 60_000; // failed: keep the old points, ask again in 5 minutes
  return cache.points;
}

export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const round = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Direction of a day: BTC by its close-to-close change (±1%), BTC.D by its change (±0.2 p.p.). */
export const btcDir = (chg: number | null) => (chg == null ? null : chg > 1 ? "up" : chg < -1 ? "down" : "flat");
export const domDir = (chgPp: number | null) => (chgPp == null ? null : chgPp > 0.2 ? "up" : chgPp < -0.2 ? "down" : "flat");

export type BtcDay = { day: string; btcClose: number | null; btcChgPct: number | null; dominance: number | null; domChgPp: number | null };

export function dailyContext(points: DominancePoint[]): Map<string, BtcDay> {
  const out = new Map<string, BtcDay>();
  points.forEach((p, i) => {
    const prev = points[i - 1];
    const adjacent = prev && p.t - prev.t <= 1.5 * DAY;
    out.set(dayKey(p.t), {
      day: dayKey(p.t),
      btcClose: p.price,
      btcChgPct: adjacent && prev!.price && p.price ? round(((p.price - prev!.price) / prev!.price) * 100) : null,
      dominance: round(p.dominance),
      domChgPp: adjacent ? round(p.dominance - prev!.dominance) : null,
    });
  });
  return out;
}

export type BtcTradeRow = JournalRow & { btc_chg24h: number | null };

export const BTC24_BUCKETS: Array<{ id: string; label: string; test: (v: number) => boolean }> = [
  { id: "lt-3", label: "≤ −3%", test: (v) => v <= -3 },
  { id: "-3-1", label: "−3…−1%", test: (v) => v > -3 && v <= -1 },
  { id: "flat", label: "−1…+1%", test: (v) => v > -1 && v < 1 },
  { id: "1-3", label: "+1…+3%", test: (v) => v >= 1 && v < 3 },
  { id: "gt3", label: "≥ +3%", test: (v) => v >= 3 },
];
export const SCENARIOS = [
  { dom: "up", btc: "up", alts: "вниз" }, { dom: "up", btc: "down", alts: "дамп" }, { dom: "up", btc: "flat", alts: "флэт" },
  { dom: "down", btc: "up", alts: "памп" }, { dom: "down", btc: "down", alts: "флэт" }, { dom: "down", btc: "flat", alts: "вверх" },
] as const;

const sideOf = (r: JournalRow) => (r.side === "short" || r.setup.endsWith("_short") ? "short" : "long");
const brief = (rows: JournalRow[]) => {
  const s = summarize(rows);
  return { closed: s.closed, winRate: s.winRate, netPnlPct: s.netPnlPct, avgProfit: s.avgProfit, avgLoss: s.avgLoss, stopLoss: s.stopLoss };
};
const bySide = (rows: JournalRow[]) => ({
  long: brief(rows.filter((r) => sideOf(r) === "long")),
  short: brief(rows.filter((r) => sideOf(r) === "short")),
});

export function buildBtcView(input: { rows: BtcTradeRow[]; points: DominancePoint[]; now: number; btcPrice: number | null; btcChg24h: number | null }) {
  const { rows, points, now } = input;
  const days = dailyContext(points);
  const last = points.at(-1) ?? null;
  const prevDay = points.length > 1 ? points[points.length - 2]! : null;
  const weekAgo = [...points].reverse().find((p) => last && last.t - p.t >= 7 * DAY - DAY / 2) ?? null;

  // By day (UTC), last 30 days.
  const from = Math.floor(now / DAY) * DAY - 29 * DAY;
  const daily = Array.from({ length: 30 }, (_, i) => {
    const day = dayKey(from + i * DAY);
    const opened = rows.filter((r) => dayKey(new Date(r.opened_at).getTime()) === day);
    const closed = rows.filter((r) => r.status === "closed" && r.closed_at && dayKey(new Date(r.closed_at).getTime()) === day);
    const ctx = days.get(day);
    return {
      day, btcClose: ctx?.btcClose ?? null, btcChgPct: ctx?.btcChgPct ?? null, dominance: ctx?.dominance ?? null, domChgPp: ctx?.domChgPp ?? null,
      opened: opened.length, closed: closed.length,
      closedPnl: round(closed.reduce((a, r) => a + Number(r.pnl_pct ?? 0), 0)),
      stops: closed.filter((r) => r.close_reason === "stop").length,
    };
  });

  const closed = rows.filter((r) => r.status === "closed");
  const withBtc = closed.filter((r) => r.btc_chg24h != null && Number.isFinite(Number(r.btc_chg24h)));
  const byBtc24h = BTC24_BUCKETS.map((b) => ({ id: b.id, label: b.label, ...bySide(withBtc.filter((r) => b.test(Number(r.btc_chg24h)))) }));

  const entryDay = (r: JournalRow) => days.get(dayKey(new Date(r.opened_at).getTime() - DAY)) ?? null; // the last closed day before the entry
  const scenarios = SCENARIOS.map((s) => ({
    ...s,
    ...bySide(closed.filter((r) => { const d = entryDay(r); return d && domDir(d.domChgPp) === s.dom && btcDir(d.btcChgPct) === s.btc; })),
  }));
  const scenarioCovered = closed.filter((r) => { const d = entryDay(r); return d && domDir(d.domChgPp) && btcDir(d.btcChgPct); }).length;

  return {
    now: {
      btcPrice: input.btcPrice, btcChg24h: input.btcChg24h,
      dominance: last ? round(last.dominance) : null, dominanceAt: last ? new Date(last.t).toISOString() : null,
      domChg1dPp: last && prevDay ? round(last.dominance - prevDay.dominance) : null,
      domChg7dPp: last && weekAgo ? round(last.dominance - weekAgo.dominance) : null,
    },
    daily,
    byBtc24h,
    scenarios,
    coverage: { closed: closed.length, withBtc24h: withBtc.length, withScenario: scenarioCovered, dominanceDays: points.length },
  };
}

/** BTC now from the 30m bars Nihilist keeps for every altcoin snapshot. */
export function btcNow(): { price: number | null; chg24h: number | null } {
  const bars = book(BTC)["30m"];
  const lastBar = bars.at(-1);
  if (!lastBar) return { price: null, chg24h: null };
  const dayAgo = [...bars].reverse().find((c) => lastBar.t - c.t >= DAY);
  return { price: lastBar.c, chg24h: dayAgo ? round(((lastBar.c - dayAgo.c) / dayAgo.c) * 100) : null };
}
