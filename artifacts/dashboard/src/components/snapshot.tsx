import { metricLabel, metricValue, type Snapshot } from "../lib/api";

const GROUPS: Array<{ title: string; keys: (k: string) => boolean }> = [
  { title: "Сетап", keys: (k) => ["risk_pct", "rr1", "tp1_pct", "targets_source", "block_scope", "block_size_pct", "entry_from_block_pct", "block_age_h", "since_first_touch_h", "since_last_touch_h", "touch_span_h", "ltf_atr_pct", "htf_swing_aligned", "htf_internal_aligned"].includes(k) },
  { title: "Монета", keys: (k) => !k.startsWith("btc_") && /^(chg|rsi_|atrpct_|ema|trend_|range)/.test(k) },
  { title: "BTC", keys: (k) => k.startsWith("btc_") && k !== "btc_price" },
];

/** Metrics at signal time (and at close) — AltBullet's "при входе / при закрытии". */
export function SnapshotPanel({ snapshot, close, reconstructed, status }: {
  snapshot?: Snapshot | null; close?: Snapshot | null; reconstructed?: boolean | null; status?: string | null;
}) {
  if (status === "unavailable") return <p className="text-muted">Метрики не восстановить: история свечей начинается позже сигнала.</p>;
  if (!snapshot) return <p className="text-muted">Метрики ещё не записаны — бэкфилл запишет их в течение нескольких минут.</p>;
  return (
    <div className="space-y-3">
      {reconstructed && <p className="text-[11px] text-warn">Восстановлено по сохранённым свечам (сигнал был до записи метрик).</p>}
      {GROUPS.map((g) => {
        const keys = Object.keys(snapshot).filter(g.keys).sort();
        if (!keys.length) return null;
        return (
          <div key={g.title}>
            <p className="label mb-1">{g.title}{close && g.title !== "Сетап" ? " · вход → закрытие" : ""}</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 font-mono text-[11px] sm:grid-cols-[1fr_auto_1fr_auto]">
              {keys.map((k) => (
                <div key={k} className="contents">
                  <dt className="truncate text-muted">{metricLabel(k)}</dt>
                  <dd className="text-right">{metricValue(snapshot[k])}{close && k in close ? <span className="text-muted"> → {metricValue(close[k])}</span> : null}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}
