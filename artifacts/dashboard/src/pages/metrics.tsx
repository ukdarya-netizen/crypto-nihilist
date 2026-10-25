import { useState } from "react";
import { Empty, Kpi, Panel, Segmented } from "../components/ui";
import { SETUPS, metricLabel, setupLabel, signed, tone, usePoll } from "../lib/api";

type Bucket = { label: string; n: number; winRate: number | null; avgR: number | null; avgPnl: number | null; sumR: number };
type Metric = { key: string; kind: "number" | "label"; n: number; buckets: Bucket[]; spreadR: number | null };
type Data = {
  closed: number;
  coverage: { signals: number; live: number; reconstructed: number; unavailable: number; pending: number };
  metrics: Metric[];
};

const valueLabel = (v: string) => (v === "true" ? "да" : v === "false" ? "нет" : v === "up" ? "вверх" : v === "down" ? "вниз" : v === "long" ? "лонг" : v === "short" ? "шорт" : v);

function MetricCard({ m }: { m: Metric }) {
  const best = Math.max(...m.buckets.map((b) => b.avgR ?? -1e9));
  const worst = Math.min(...m.buckets.map((b) => b.avgR ?? 1e9));
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{metricLabel(m.key)}</p>
        <p className="font-mono text-[10px] text-muted">{m.n} сделок · разброс {signed(m.spreadR, 2, "R")}</p>
      </div>
      <table className="w-full font-mono text-[11px]">
        <thead><tr className="text-left text-muted"><th className="font-normal">{m.kind === "number" ? "диапазон" : "значение"}</th><th className="text-right font-normal">n</th><th className="text-right font-normal">win</th><th className="text-right font-normal">ср. R</th><th className="text-right font-normal">ср. %</th></tr></thead>
        <tbody>
          {m.buckets.map((b) => (
            <tr key={b.label} className={`border-t border-border ${b.avgR === best ? "bg-up/[0.07]" : b.avgR === worst ? "bg-down/[0.07]" : ""}`}>
              <td className="py-1 pr-2">{m.kind === "number" ? b.label : valueLabel(b.label)}</td>
              <td className="text-right">{b.n}</td>
              <td className="text-right">{b.winRate === null ? "—" : `${b.winRate}%`}</td>
              <td className={`text-right ${tone(b.avgR)}`}>{signed(b.avgR)}</td>
              <td className={`text-right ${tone(b.avgPnl)}`}>{signed(b.avgPnl, 2, "%")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Metrics() {
  const [days, setDays] = useState(90);
  const [setup, setSetup] = useState("");
  const [side, setSide] = useState<"" | "long" | "short">("");
  const [q, setQ] = useState("");
  const params = new URLSearchParams({ days: String(days) });
  if (setup) params.set("setup", setup);
  if (side) params.set("side", side);
  const { data } = usePoll<Data>(`/nh/metrics?${params}`, 60_000);
  const shown = (data?.metrics ?? []).filter((m) => !q || metricLabel(m.key).toLowerCase().includes(q.toLowerCase()));
  const c = data?.coverage;
  return (
    <div className="space-y-4 md:space-y-6">
      <p className="text-sm text-muted">
        По каждой закрытой сделке записан срез рынка в момент сигнала (как снапшоты AltBullet): геометрия сетапа, RSI, ATR, EMA, изменения цены,
        положение в диапазоне, тренд — у монеты и у BTC. Только теханализ, без объёмов. Ниже каждая метрика разбита на группы
        (числа — на четверти по значению); зелёным — лучшая группа по среднему R, красным — худшая. Метрики сверху сильнее всего разделяют
        прибыль и стопы — это кандидаты в фильтры входа. Малое n — не вывод.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Закрытых сделок с метриками" value={data?.closed ?? "—"} />
        <Kpi label="Записано при сигнале" value={c?.live ?? "—"} />
        <Kpi label="Восстановлено бэкфиллом" value={c?.reconstructed ?? "—"} hint={c ? `ещё в очереди ${c.pending}` : undefined} />
        <Kpi label="Не восстановить" value={c?.unavailable ?? "—"} hint="история свечей позже сигнала" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<number> value={days} onChange={setDays} options={[{ id: 30, label: "30 дн" }, { id: 90, label: "90 дн" }, { id: 3650, label: "всё" }]} />
        <Segmented<"" | "long" | "short"> value={side} onChange={setSide} options={[{ id: "", label: "все" }, { id: "long", label: "лонг" }, { id: "short", label: "шорт" }]} />
        <select value={setup} onChange={(e) => setSetup(e.target.value)} className="h-8 border border-border bg-background px-2 text-xs">
          <option value="">Все сетапы</option>
          {SETUPS.map((s) => <option key={s} value={s}>{setupLabel(s)}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск метрики" className="h-8 w-40 border border-border bg-transparent px-2 text-xs outline-none" />
      </div>
      {!data ? <Panel><Empty>Загрузка…</Empty></Panel> : !shown.length ? (
        <Panel><Empty>Пока мало закрытых сделок с метриками: нужно хотя бы 6 по метрике.</Empty></Panel>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">{shown.map((m) => <MetricCard key={m.key} m={m} />)}</div>
      )}
    </div>
  );
}
