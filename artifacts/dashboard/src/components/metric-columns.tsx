import { compact, metricLabel, type Snapshot } from "../lib/api";

/** Metric columns of the signal lists (as AltBullet's tracker/history). */
export const METRIC_COLUMNS: Array<{ key: string; head: string; suffix?: string; signed?: boolean }> = [
  { key: "ob_displacement_atr", head: "ОБ сила", suffix: "×" },
  { key: "ob_penetration_pct", head: "Глуб. ОБ", suffix: "%" },
  { key: "d_oi_chg1h", head: "OI 1ч", suffix: "%", signed: true },
  { key: "d_oi_chg24h", head: "OI 24ч", suffix: "%", signed: true },
  { key: "d_fut_taker_net_1h", head: "F TKR 1ч", suffix: "%", signed: true },
  { key: "d_spot_cvd_chg1h", head: "CVD 1ч", signed: true },
  { key: "d_funding_pct", head: "Funding", suffix: "%", signed: true },
  { key: "d_ls_long_pct", head: "L/S лонг", suffix: "%" },
  { key: "rsi_1h", head: "RSI 1ч" },
  { key: "btc_chg24h", head: "BTC 24ч", suffix: "%", signed: true },
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
