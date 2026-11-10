import { isOwner, compact, metricLabel, type Snapshot } from "../lib/api";

/** Metric columns of the signal lists (as AltBullet's tracker/history). */
/**
 * Owner 2026-11-10: only what decides a trade — the long entry filter (stop ≥7%, block ≤300 h, block ≥4%,
 * ATR 1H ≥1.9%) and the stop distance that splits shorts (≥9.5%: stop beyond liquidation at 10x).
 * The VSA volume columns are gone (no longer recorded); the rest stays in the card.
 */
export const METRIC_COLUMNS: Array<{ key: string; head: string; suffix?: string; signed?: boolean }> = [
  { key: "risk_pct", head: "Стоп при входе", suffix: "%" },
  { key: "atrpct_1h", head: "ATR 1h", suffix: "%" },
  { key: "block_age_h", head: "Возраст ОБ", suffix: "ч" },
  { key: "block_size_pct", head: "Высота ОБ", suffix: "%" },
];

export function MetricCell({ snapshot, col }: { snapshot?: Snapshot | null; col: (typeof METRIC_COLUMNS)[number] }) {
  const v = snapshot?.[col.key];
  const n = typeof v === "number" ? v : null;
  const cls = !col.signed || n === null || n === 0 ? "" : n > 0 ? "text-up" : "text-down";
  return (
    <td className={`whitespace-nowrap pr-3 text-xs ${cls}`} title={metricLabel(col.key)}>
      {n === null ? <span className="text-muted/50">—</span> : `${col.signed && n > 0 ? "+" : ""}${compact(n)}${col.suffix ?? ""}`}
    </td>
  );
}

/** Entry-metric columns: owner only (users do not see the research metrics). */
export const metricCols = () => (isOwner() ? METRIC_COLUMNS : []);
