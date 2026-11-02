import { isOwner, compact, metricLabel, type Snapshot } from "../lib/api";

/** Metric columns of the signal lists (as AltBullet's tracker/history). */
/**
 * Only metrics that separated profits from stops in the 25.10–02.11 analysis
 * (owner 2026-11-02): stop at entry, order-block age and height, volatility,
 * and VSA volume. The rest (OI, L/S, RSI, BTC, OB strength) stays in the card.
 */
export const METRIC_COLUMNS: Array<{ key: string; head: string; suffix?: string; signed?: boolean }> = [
  { key: "risk_pct", head: "Стоп при входе", suffix: "%" },
  { key: "block_age_h", head: "Возраст ОБ", suffix: "ч" },
  { key: "block_size_pct", head: "Высота ОБ", suffix: "%" },
  { key: "atrpct_30m", head: "ATR 30m", suffix: "%" },
  { key: "vsa_ext_vol_rel", head: "Объём экстр.", suffix: "×" },
  { key: "vsa_choch_vol_rel", head: "Объём слома", suffix: "×" },
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
