import { useState, type ReactNode } from "react";
import { Activity, AlertTriangle, BarChart3, Shield, TrendingDown, TrendingUp, Trophy, Zap } from "lucide-react";
import { Empty, Panel, Segmented } from "../components/ui";
import { SignalHistory, type TradeStatus } from "../components/signal-history";
import { SETUPS, coin, setupLabel, signed, tone, usePoll, type Status } from "../lib/api";

type Summary = {
  total: number; open: number; closed: number; profit: number; beStop: number; stopLoss: number; expired: number;
  beBuckets: { lt5: number; after5: number; after8: number; after10: number };
  winRate: number | null; netPnlPct: number; netR: number;
  pnlByStatus: { profit: number; beStop: number; stopLoss: number; expired: number };
  avgProfit: number | null; avgLoss: number | null; avgPeak: number | null;
  reached: { p5: number; p10: number; p15: number; p30: number };
  bestTrade: { symbol: string; setup: string; pnlPct: number; id: number } | null;
};
type Journal = {
  counters: { today: number; total: number };
  summary: Summary;
  bySetup: Array<Summary & { setup: string }>;
  daily: Array<{ day: string; trades: number; wins: number; pnl: number; r: number }>;
};

function StatCard({ title, value, sub, icon: Icon, color = "", onClick, active, bar }: {
  title: string; value: ReactNode; sub?: ReactNode; icon: typeof Zap; color?: string; onClick?: () => void; active?: boolean; bar?: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`panel p-4 text-left transition ${onClick ? "hover:border-primary/40" : "cursor-default"} ${active ? "!border-primary/60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="label">{title}</p>
        <Icon className={`size-4 ${color || "text-muted"}`} />
      </div>
      <p className={`mt-2 text-2xl font-semibold tabular ${color}`}>{value}</p>
      {sub && <p className="mt-1 text-[11px] text-muted">{sub}</p>}
      {bar}
    </button>
  );
}

function WinBar({ s }: { s: Summary }) {
  const total = s.profit + s.beStop + s.stopLoss;
  if (!total) return null;
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="mt-2 flex h-1.5 overflow-hidden bg-border">
      <span className="bg-up" style={{ width: w(s.profit) }} />
      <span className="bg-sky-400" style={{ width: w(s.beStop) }} />
      <span className="bg-down" style={{ width: w(s.stopLoss) }} />
    </div>
  );
}

function DailyChart({ rows, metric }: { rows: Journal["daily"]; metric: "pnl" | "r" }) {
  if (!rows.length) return <Empty>Закрытых сделок за период ещё нет.</Empty>;
  let acc = 0;
  const pts = rows.map((r) => ({ ...r, v: r[metric], cum: (acc += r[metric]) }));
  const max = Math.max(0.0001, ...pts.map((p) => Math.abs(p.v)));
  const cumMax = Math.max(0.0001, ...pts.map((p) => Math.abs(p.cum)));
  const w = 100 / pts.length;
  const unit = metric === "pnl" ? "%" : "R";
  return (
    <div>
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="h-52 w-full" role="img" aria-label="Результат по дням">
        <line x1="0" x2="100" y1="30" y2="30" stroke="currentColor" className="text-border" strokeWidth="0.3" />
        {pts.map((p, i) => {
          const h = (Math.abs(p.v) / max) * 27;
          return (
            <rect key={p.day} x={i * w + w * 0.15} width={w * 0.7} y={p.v >= 0 ? 30 - h : 30} height={Math.max(h, 0.4)}
              className={p.v >= 0 ? "fill-up/70" : "fill-down/80"}>
              <title>{`${p.day}: ${p.trades} сделок, в плюс ${p.wins}, ${signed(p.v, 2, unit)} · накоплено ${signed(p.cum, 2, unit)}`}</title>
            </rect>
          );
        })}
        <polyline fill="none" stroke="#efe7e1" strokeWidth="0.6" vectorEffect="non-scaling-stroke"
          points={pts.map((p, i) => `${i * w + w / 2},${30 - (p.cum / cumMax) * 27}`).join(" ")} />
      </svg>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
        <span>{pts[0].day.slice(5)}</span><span>{pts[pts.length - 1].day.slice(5)}</span>
      </div>
      <p className="mt-1 text-center font-mono text-[10px] text-muted">столбцы — результат дня · линия — накопленный ({signed(acc, 2, unit)})</p>
    </div>
  );
}

export default function Overview() {
  const [days, setDays] = useState(30);
  const [live, setLive] = useState(false);
  const [metric, setMetric] = useState<"pnl" | "r">("pnl");
  const [status, setStatus] = useState<"" | TradeStatus>("");
  const { data } = usePoll<Journal>(`/nh/journal?days=${days}${live ? "&live=1" : ""}`);
  const st = usePoll<Status>("/nh/status", 60_000).data;
  const s = data?.summary;
  const bySetup = new Map((data?.bySetup ?? []).map((r) => [r.setup, r]));
  const focus = (next: "" | TradeStatus) => {
    setStatus(next);
    document.getElementById("signal-history")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard title="СИГНАЛОВ СЕГОДНЯ" value={data?.counters.today ?? "—"} icon={Zap} color="text-primary" />
        <StatCard title="ВСЕГО СИГНАЛОВ" value={data?.counters.total ?? "—"} icon={BarChart3} />
        <StatCard title="МОНЕТ СКАНИРУЕТСЯ" value={st ? st.engine.ready : "—"} sub={st ? `из ${st.engine.universe} пар BingX` : undefined} icon={Activity} color="text-up" />
        <StatCard title="АКТИВНЫХ" value={s?.open ?? "—"} sub="сделок в работе" icon={AlertTriangle} color="text-warn" onClick={() => focus("open")} active={status === "open"} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-muted">Общая статистика · сигналы, открытые за {days >= 3650 ? "всё время" : `${days} дн`}</p>
        <div className="flex flex-wrap gap-2">
          <Segmented<boolean> value={live} onChange={setLive} options={[{ id: false, label: "все сетапы" }, { id: true, label: "только канал" }]} />
          <Segmented<number> value={days} onChange={setDays} options={[{ id: 7, label: "7 дн" }, { id: 14, label: "14 дн" }, { id: 30, label: "30 дн" }, { id: 90, label: "90 дн" }, { id: 3650, label: "всё" }]} />
        </div>
      </div>

      <section className="panel border-up/30 p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label">Счётчик прибыли — чистый результат</p>
            <p className={`mt-1 font-mono text-4xl font-semibold ${tone(s?.netPnlPct)}`}>{s ? signed(s.netPnlPct, 2, "%") : "—"}</p>
            <p className="mt-1 text-xs text-muted">{s ? `${signed(s.netR, 2)}R · ${s.closed} закрытых сделок` : ""}</p>
          </div>
          {s && (
            <p className="max-w-xl text-right text-[11px] leading-relaxed text-muted">
              PROFIT {s.profit} ({signed(s.pnlByStatus.profit, 2, "%")}) · BE STOP {s.beStop} ({signed(s.pnlByStatus.beStop, 2, "%")}) ·
              STOP LOSS {s.stopLoss} ({signed(s.pnlByStatus.stopLoss, 2, "%")}) · EXPIRED {s.expired} ({signed(s.pnlByStatus.expired, 2, "%")})
              <br />Сумма движения цены по всем закрытым сделкам: половина на тейке 1 и комиссии учтены, без плеча.
            </p>
          )}
        </div>
      </section>

      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <StatCard title="WIN RATE" value={s.winRate === null ? "—" : `${s.winRate}%`} sub={`PROFIT ${s.profit} / BE ${s.beStop} / STOP ${s.stopLoss}`}
            icon={Trophy} color={s.winRate !== null && s.winRate >= 30 ? "text-up" : "text-warn"} bar={<WinBar s={s} />} />
          <StatCard title="BE +5%" value={s.beBuckets.after5} sub="пик +5…<8%" icon={Shield} color="text-sky-300" onClick={() => focus("be_stop")} />
          <StatCard title="BE +8%" value={s.beBuckets.after8} sub="пик +8…<10%" icon={Shield} color="text-sky-300" onClick={() => focus("be_stop")} />
          <StatCard title="BE +10%+" value={s.beBuckets.after10} sub="пик от +10%" icon={Shield} color="text-sky-300" onClick={() => focus("be_stop")} />
          <StatCard title="AVG PROFIT" value={signed(s.avgProfit, 2, "%")} sub={`${s.profit} PROFIT`} icon={TrendingUp} color="text-up" onClick={() => focus("profit")} active={status === "profit"} />
          <StatCard title="AVG LOSS" value={signed(s.avgLoss, 2, "%")} sub={`STOP LOSS: ${s.stopLoss}`} icon={TrendingDown} color="text-down" onClick={() => focus("stop_loss")} active={status === "stop_loss"} />
          <StatCard title="ЛУЧШАЯ СДЕЛКА" value={s.bestTrade ? signed(s.bestTrade.pnlPct, 2, "%") : "—"} sub={s.bestTrade ? `${coin(s.bestTrade.symbol)} · ${setupLabel(s.bestTrade.setup)}` : "—"} icon={Trophy} color="text-up" />
          <StatCard title="СРЕДНИЙ ПИК" value={signed(s.avgPeak, 1, "%")} sub={`до +10%: ${s.reached.p10} · до +15%: ${s.reached.p15} · до +30%: ${s.reached.p30}`} icon={TrendingUp} />
        </div>
      )}

      <Panel title="График прибыльности по дням" right={<Segmented<"pnl" | "r"> value={metric} onChange={setMetric} options={[{ id: "pnl", label: "%" }, { id: "r", label: "R" }]} />}>
        <DailyChart rows={data?.daily ?? []} metric={metric} />
      </Panel>

      <Panel title="Результаты по сетапам">
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left">{["Сетап", "Всего", "PROFIT", "BE STOP", "STOP", "Win rate", "Результат", "R", "Средний пик", "Откр."].map((h) => <th key={h} className="label pb-2 pr-3 font-normal">{h}</th>)}</tr>
            </thead>
            <tbody className="tabular">
              {SETUPS.map((name) => {
                const r = bySetup.get(name);
                return (
                  <tr key={name} className="border-t border-border">
                    <td className="py-2.5 pr-3 font-sans">{setupLabel(name)}</td>
                    <td className="pr-3">{r?.total ?? 0}</td>
                    <td className="pr-3 text-up">{r?.profit ?? 0}</td>
                    <td className="pr-3 text-sky-300">{r?.beStop ?? 0}</td>
                    <td className="pr-3 text-down">{r?.stopLoss ?? 0}</td>
                    <td className="pr-3">{r?.winRate == null ? "—" : `${r.winRate}%`}</td>
                    <td className={`pr-3 ${tone(r?.netPnlPct)}`}>{r ? signed(r.netPnlPct, 2, "%") : "—"}</td>
                    <td className={`pr-3 ${tone(r?.netR)}`}>{r ? signed(r.netR) : "—"}</td>
                    <td className="pr-3">{signed(r?.avgPeak, 1, "%")}</td>
                    <td>{r?.open ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">Win rate как в CAB: (PROFIT + BE STOP) / (PROFIT + BE STOP + STOP LOSS). BE STOP — закрытие по стопу на входе после тейка 1; +5/+8/+10 — какого пика сделка успела достичь.</p>
      </Panel>

      <div id="signal-history" className="scroll-mt-4">
        <SignalHistory days={days} live={live} status={status} onStatus={setStatus} />
      </div>
    </div>
  );
}
