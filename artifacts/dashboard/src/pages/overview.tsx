import { useState } from "react";
import { Empty, Kpi, Panel, Segmented, Table } from "../components/ui";
import { SETUPS, num, setupLabel, signed, tone, usePoll, type DailyRow, type StatRow } from "../lib/api";

function DailyChart({ rows }: { rows: DailyRow[] }) {
  if (!rows.length) return <Empty>Закрытых сделок за период ещё нет.</Empty>;
  let acc = 0;
  const points = rows.map((r) => ({ ...r, cum: (acc += r.sum_r) }));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.sum_r)));
  const cumMax = Math.max(1, ...points.map((p) => Math.abs(p.cum)));
  const w = 100 / rows.length;
  return (
    <div>
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="h-48 w-full" role="img" aria-label="Результат по дням, R">
        <line x1="0" x2="100" y1="30" y2="30" stroke="currentColor" className="text-border" strokeWidth="0.3" />
        {points.map((p, i) => {
          const h = (Math.abs(p.sum_r) / max) * 28;
          return (
            <rect key={p.day} x={i * w + w * 0.15} width={w * 0.7} y={p.sum_r >= 0 ? 30 - h : 30} height={Math.max(h, 0.4)}
              className={p.sum_r >= 0 ? "fill-up/70" : "fill-down/80"}>
              <title>{`${p.day}: ${p.trades} сделок, ${signed(p.sum_r)}R`}</title>
            </rect>
          );
        })}
        <polyline fill="none" stroke="#efe7e1" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
          points={points.map((p, i) => `${i * w + w / 2},${30 - (p.cum / cumMax) * 28}`).join(" ")} />
      </svg>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
        <span>{rows[0].day.slice(5)}</span>
        <span>{rows[rows.length - 1].day.slice(5)}</span>
      </div>
      <p className="mt-1 text-center font-mono text-[10px] text-muted">столбцы — R за день · линия — накопленный R ({signed(acc)}R)</p>
    </div>
  );
}

export default function Overview() {
  const [days, setDays] = useState(30);
  const stats = usePoll<{ setups: StatRow[]; open: Array<{ setup: string; open: number }> }>(`/nh/stats?days=${days}`);
  const daily = usePoll<{ daily: DailyRow[] }>(`/nh/stats/daily?days=${days}`);
  const rows = stats.data?.setups ?? [];
  const byName = new Map(rows.map((s) => [s.setup, s]));
  const openBy = new Map((stats.data?.open ?? []).map((o) => [o.setup, o.open]));
  const trades = rows.reduce((a, r) => a + r.trades, 0);
  const wins = rows.reduce((a, r) => a + r.wins, 0);
  const sumR = rows.reduce((a, r) => a + (r.sum_r ?? 0), 0);
  const pnl = rows.reduce((a, r) => a + (r.avg_pnl_pct ?? 0) * r.trades, 0);
  const open = [...openBy.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Ордер-блок 4h/1D → слом структуры 30m/1h · фьючерсы BingX</p>
        <Segmented<number> value={days} onChange={setDays} options={[{ id: 7, label: "7 дн" }, { id: 30, label: "30 дн" }, { id: 90, label: "90 дн" }, { id: 3650, label: "всё" }]} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Результат" value={trades ? `${signed(sumR)}R` : "—"} toneClass={tone(sumR)} hint="в размерах стопа" />
        <Kpi label="Винрейт" value={trades ? `${Math.round((wins / trades) * 100)}%` : "—"} hint={`${wins} из ${trades} в плюс`} />
        <Kpi label="Средняя сделка" value={trades ? `${signed(pnl / trades)}%` : "—"} toneClass={tone(pnl)} hint="движение цены, комиссии учтены" />
        <Kpi label="Открыто сейчас" value={open} hint="сделок в работе" />
      </div>
      <Panel title="Результат по дням">
        <DailyChart rows={daily.data?.daily ?? []} />
      </Panel>
      <Panel title="Сетапы">
        <Table head={["Сетап", "Сделок", "В плюс", "Тейк 1", "Стоп", "Сред. R", "Сумма R", "Сред. %", "Откр."]}>
          {SETUPS.map((name) => {
            const s = byName.get(name);
            const pct = (n: number) => (s?.trades ? `${Math.round((n / s.trades) * 100)}%` : "—");
            return (
              <tr key={name} className="border-t border-border">
                <td className="py-2.5 pr-3 font-sans">{setupLabel(name)}</td>
                <td className="pr-3">{s?.trades ?? 0}</td>
                <td className="pr-3">{pct(s?.wins ?? 0)}</td>
                <td className="pr-3">{pct(s?.tp1 ?? 0)}</td>
                <td className="pr-3">{pct(s?.stops ?? 0)}</td>
                <td className={`pr-3 ${tone(s?.avg_r)}`}>{num(s?.avg_r)}</td>
                <td className={`pr-3 ${tone(s?.sum_r)}`}>{signed(s?.sum_r)}</td>
                <td className={`pr-3 ${tone(s?.avg_pnl_pct)}`}>{signed(s?.avg_pnl_pct)}</td>
                <td>{openBy.get(name) ?? 0}</td>
              </tr>
            );
          })}
        </Table>
        <p className="mt-3 text-xs text-muted">R — результат в размерах стопа: +2R значит заработано два стопа. % — движение цены без плеча, комиссии 0,05% на вход и выход учтены.</p>
      </Panel>
    </div>
  );
}
