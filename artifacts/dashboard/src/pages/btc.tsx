import { useState, type ReactNode } from "react";
import { Bitcoin, Percent, TrendingUp } from "lucide-react";
import { Empty, Panel, Segmented, Table } from "../components/ui";
import { isOwner, price, signed, tone, usePoll } from "../lib/api";

/**
 * BTC (owner 2026-11-13, as the CAB «BTC» page): Bitcoin and its dominance as the context of our altcoin trades.
 * Observational — nothing here changes the signals.
 */
type Brief = { closed: number; winRate: number | null; netPnlPct: number; avgProfit: number | null; avgLoss: number | null; stopLoss: number };
type Sides = { long: Brief; short: Brief };
type BtcView = {
  now: { btcPrice: number | null; btcChg24h: number | null; dominance: number | null; dominanceAt: string | null; domChg1dPp: number | null; domChg7dPp: number | null };
  daily: Array<{ day: string; btcClose: number | null; btcChgPct: number | null; dominance: number | null; domChgPp: number | null; opened: number; closed: number; closedPnl: number | null; stops: number }>;
  byBtc24h: Array<{ id: string; label: string } & Sides>;
  scenarios: Array<{ dom: "up" | "down"; btc: "up" | "down" | "flat"; alts: string } & Sides>;
  coverage: { closed: number; withBtc24h: number; withScenario: number; dominanceDays: number };
};

const DIR: Record<string, string> = { up: "вверх", down: "вниз", flat: "флэт" };
const dirTone = (d: string) => (d === "вверх" || d === "памп" ? "text-up" : d === "вниз" || d === "дамп" ? "text-down" : "text-muted");
const pp = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)} п.п.`);

function Stat({ title, value, sub, icon: Icon }: { title: string; value: ReactNode; sub?: ReactNode; icon: typeof Bitcoin }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2"><p className="label">{title}</p><Icon className="size-4 text-muted" /></div>
      <p className="mt-2 text-2xl font-semibold tabular">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

/** BTC close (line) and BTC.D (line, right scale) by day, our day result as bars under them. */
function DayChart({ daily }: { daily: BtcView["daily"] }) {
  const W = 1000, H = 300, PAD = 48, BAR_H = 70;
  const n = daily.length;
  const x = (i: number) => PAD + (i + 0.5) * ((W - 2 * PAD) / n);
  const prices = daily.map((d) => d.btcClose).filter((v): v is number => v != null);
  const doms = daily.map((d) => d.dominance).filter((v): v is number => v != null);
  const pnl = daily.map((d) => Math.abs(d.closedPnl ?? 0));
  const scale = (vs: number[]) => { const lo = Math.min(...vs), hi = Math.max(...vs); return (v: number) => 12 + ((hi - v) / (hi - lo || 1)) * (H - BAR_H - 40); };
  const yP = prices.length ? scale(prices) : null, yD = doms.length ? scale(doms) : null;
  const maxPnl = Math.max(1, ...pnl);
  const base = H - BAR_H / 2 - 8;
  const path = (vals: Array<number | null>, y: (v: number) => number) =>
    vals.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="BTC, BTC.D и наш результат по дням">
      {yP && <polyline points={path(daily.map((d) => d.btcClose), yP)} fill="none" stroke="#f59e0b" strokeWidth="2.5" />}
      {yD && <polyline points={path(daily.map((d) => d.dominance), yD)} fill="none" stroke="#a78bfa" strokeWidth="2" strokeDasharray="6 4" />}
      <line x1={PAD} x2={W - PAD} y1={base} y2={base} stroke="currentColor" opacity="0.2" />
      {daily.map((d, i) => {
        const v = d.closedPnl ?? 0;
        const h = (Math.abs(v) / maxPnl) * (BAR_H / 2 - 4);
        return v === 0 ? null : <rect key={d.day} x={x(i) - 9} width="18" y={v > 0 ? base - h : base} height={h} className={v > 0 ? "fill-up" : "fill-down"} opacity="0.85"><title>{`${d.day}: ${v > 0 ? "+" : ""}${v}% · закрыто ${d.closed}`}</title></rect>;
      })}
      {daily.map((d, i) => (i % 5 === 0 || i === n - 1) && <text key={`t${d.day}`} x={x(i)} y={H - 2} textAnchor="middle" fontSize="12" fill="currentColor" opacity="0.6">{d.day.slice(5)}</text>)}
      {prices.length > 0 && <text x={PAD - 6} y={16} textAnchor="end" fontSize="12" fill="#f59e0b">{Math.round(Math.max(...prices)).toLocaleString("ru-RU")}</text>}
      {doms.length > 0 && <text x={W - PAD + 6} y={16} fontSize="12" fill="#a78bfa">{Math.max(...doms).toFixed(1)}%</text>}
    </svg>
  );
}

const cell = (b: Brief) => b.closed === 0
  ? <span className="text-muted">—</span>
  : <span><span className={tone(b.netPnlPct)}>{signed(b.netPnlPct, 1, "%")}</span> <span className="text-muted">· {b.closed} сд. · винрейт {b.winRate ?? "—"}{b.winRate == null ? "" : "%"}</span></span>;

export default function Btc() {
  const [live, setLive] = useState(false);
  const { data, error } = usePoll<BtcView>(`/nh/btc${live ? "?live=1" : ""}`, 60_000);
  if (error) return <Panel title="BTC"><Empty>Не удалось загрузить BTC: {error.message}</Empty></Panel>;
  if (!data) return <Panel title="BTC"><Empty>Загрузка BTC…</Empty></Panel>;
  const n = data.now;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat title="Цена BTC" icon={Bitcoin} value={n.btcPrice == null ? price(null) : `$${Math.round(n.btcPrice).toLocaleString("ru-RU")}`} sub={<>за 24ч <span className={tone(n.btcChg24h)}>{signed(n.btcChg24h, 2, "%")}</span></>} />
        <Stat title="Доминация BTC (BTC.D)" icon={Percent} value={n.dominance == null ? "—" : `${n.dominance.toFixed(2)}%`}
          sub={n.dominanceAt ? `CoinGlass, день ${n.dominanceAt.slice(0, 10)}` : "нет данных CoinGlass"} />
        <Stat title="BTC.D за день" icon={TrendingUp} value={<span className={tone(n.domChg1dPp)}>{pp(n.domChg1dPp)}</span>} sub="рост BTC.D — деньги уходят из альтов в BTC" />
        <Stat title="BTC.D за 7 дней" icon={TrendingUp} value={<span className={tone(n.domChg7dPp)}>{pp(n.domChg7dPp)}</span>} />
      </div>

      <Panel title="BTC, BTC.D и наш результат по дням (UTC, 30 дней)"
        right={isOwner() ? <Segmented value={live} onChange={(v) => setLive(v as boolean)} options={[{ id: false, label: "все сетапы" }, { id: true, label: "только канал" }]} /> : undefined}>
        <p className="mb-2 text-xs text-muted"><span className="text-[#f59e0b]">━ цена BTC</span> · <span className="text-[#a78bfa]">┅ BTC.D</span> · столбцы — сумма результата сделок, закрытых в этот день (чистое движение цены, без плеча).</p>
        <DayChart daily={data.daily} />
        <div className="mt-4" />
        <Table head={["День", "BTC", "BTC за день", "BTC.D", "BTC.D за день", "Сигналов", "Закрыто", "Итог закрытых", "Стопов"]} minWidth={820}>
          {[...data.daily].reverse().map((d) => (
            <tr key={d.day} className="border-t border-border/60">
              <td className="py-1.5 pr-3">{d.day}</td>
              <td className="pr-3">{d.btcClose == null ? "—" : Math.round(d.btcClose).toLocaleString("ru-RU")}</td>
              <td className={`pr-3 ${tone(d.btcChgPct)}`}>{signed(d.btcChgPct, 2, "%")}</td>
              <td className="pr-3">{d.dominance == null ? "—" : `${d.dominance.toFixed(2)}%`}</td>
              <td className={`pr-3 ${tone(d.domChgPp)}`}>{pp(d.domChgPp)}</td>
              <td className="pr-3">{d.opened || "—"}</td>
              <td className="pr-3">{d.closed || "—"}</td>
              <td className={`pr-3 ${tone(d.closedPnl)}`}>{d.closed ? signed(d.closedPnl, 2, "%") : "—"}</td>
              <td className={`pr-3 ${d.stops ? "text-down" : "text-muted"}`}>{d.stops || "—"}</td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel title="Наши сделки по BTC за 24ч на входе (закрытые, 60 дней)">
        <p className="mb-3 text-xs text-muted">BTC за 24ч до сигнала — из снимка на входе. Итог — сумма чистого движения цены; винрейт как в КАБ: (профит + безубыток) / (профит + безубыток + стоп). Есть BTC на входе у {data.coverage.withBtc24h} из {data.coverage.closed} закрытых.</p>
        <Table head={["BTC за 24ч на входе", "Лонги", "Шорты"]} minWidth={640}>
          {data.byBtc24h.map((b) => (
            <tr key={b.id} className="border-t border-border/60">
              <td className="py-1.5 pr-3">{b.label}</td>
              <td className="pr-3">{cell(b.long)}</td>
              <td className="pr-3">{cell(b.short)}</td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel title="Шпаргалка BTC.D + BTC → альты, и как на этом отработал Нигилист">
        <p className="mb-3 text-xs text-muted">Условные сценарии (как в КАБ), не прогноз для каждой монеты. Рядом — наши закрытые сделки, открытые после такого дня: BTC за день вверх / вниз — больше ±1%, иначе флэт; BTC.D — больше ±0.2 п.п. Попало в сценарии {data.coverage.withScenario} из {data.coverage.closed} закрытых (остальные — дни с флэтом BTC.D или без данных).</p>
        <Table head={["BTC.D", "BTC", "Альты", "Наши лонги", "Наши шорты"]} minWidth={760}>
          {data.scenarios.map((s) => (
            <tr key={`${s.dom}-${s.btc}`} className="border-t border-border/60">
              <td className={`py-1.5 pr-3 font-semibold ${dirTone(DIR[s.dom]!)}`}>{DIR[s.dom]}</td>
              <td className={`pr-3 font-semibold ${dirTone(DIR[s.btc]!)}`}>{DIR[s.btc]}</td>
              <td className={`pr-3 font-semibold ${dirTone(s.alts)}`}>{s.alts}</td>
              <td className="pr-3">{cell(s.long)}</td>
              <td className="pr-3">{cell(s.short)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
