import { useEffect, useState } from "react";
import { compact, get, signed, tone, when } from "../lib/api";

type Point = { label: string; at: string; price: number | null; pct_from_entry: number | null; metrics: Record<string, number | string | null>; reconstructed: boolean };
const COLS: Array<[string, string, string?]> = [
  ["d_oi_chg1h", "OI 1ч", "%"], ["d_fut_taker_net_1h", "F TKR 1ч", "%"], ["d_spot_cvd_chg1h", "CVD 1ч"],
  ["d_funding_pct", "Funding", "%"], ["rsi_1h", "RSI 1ч"], ["btc_chg1h", "BTC 1ч", "%"],
];

/** The market at fixed points after entry (AltBullet trajectory snapshots). */
export function Trajectory({ id }: { id: number }) {
  const [points, setPoints] = useState<Point[] | null>(null);
  useEffect(() => {
    let alive = true;
    get<{ points: Point[] }>(`/nh/signals/${id}/trajectory`).then((d) => alive && setPoints(d.points)).catch(() => alive && setPoints([]));
    return () => { alive = false; };
  }, [id]);
  if (points === null) return <p className="text-muted">Загрузка…</p>;
  if (!points.length) return <p className="text-muted">Первая точка — через 15 минут после входа (дальше 30м, 1ч, 2ч, 4ч, 8ч, 24ч, 48ч, 72ч и раз в сутки).</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] font-mono text-[11px]">
        <thead><tr className="text-left text-muted">{["Точка", "Время", "Цена", "От входа", ...COLS.map((c) => c[1])].map((h) => <th key={h} className="pb-1 pr-3 font-normal">{h}</th>)}</tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label} className="border-t border-border">
              <td className="py-1 pr-3">{p.label}{p.reconstructed ? <span className="text-muted">*</span> : ""}</td>
              <td className="pr-3 text-muted">{when(p.at)}</td>
              <td className="pr-3">{p.price === null ? "—" : compact(p.price)}</td>
              <td className={`pr-3 ${tone(p.pct_from_entry)}`}>{signed(p.pct_from_entry, 2, "%")}</td>
              {COLS.map(([k, , suf]) => {
                const v = p.metrics?.[k];
                return <td key={k} className={`pr-3 ${typeof v === "number" && k !== "rsi_1h" ? tone(v) : ""}`}>{typeof v === "number" ? `${compact(v)}${suf ?? ""}` : "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-muted">* восстановлено позже по истории свечей и CoinGlass</p>
    </div>
  );
}
