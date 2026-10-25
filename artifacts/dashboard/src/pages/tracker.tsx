import { Empty, Panel, SideTag } from "../components/ui";
import { coin, livePct, price, setupLabel, signed, tone, usePoll, when, type Signal } from "../lib/api";

/** Where the last price sits between the stop (0%) and TP2 (100%). */
function progress(s: Signal): number | null {
  if (s.last_price === null) return null;
  const lo = s.stop;
  const hi = s.tp2;
  const v = (Number(s.last_price) - lo) / (hi - lo);
  return Math.max(0, Math.min(1, v)) * 100;
}

function Card({ s }: { s: Signal }) {
  const live = livePct(s);
  const p = progress(s);
  const entryAt = ((s.entry - s.stop) / (s.tp2 - s.stop)) * 100;
  const tp1At = ((s.tp1 - s.stop) / (s.tp2 - s.stop)) * 100;
  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-lg font-semibold">{coin(s.symbol)} <SideTag side={s.side} /></p>
          <p className="mt-0.5 text-xs text-muted">{setupLabel(s.setup)} · {s.block_scope === "swing" ? "swing-блок" : "internal-блок"}</p>
        </div>
        <div className="text-right">
          <p className={`font-mono text-xl font-semibold ${tone(live)}`}>{signed(live, 2, "%")}</p>
          <p className="text-[11px] text-muted">открыта {when(s.opened_at)}</p>
        </div>
      </div>
      <div className="relative mt-4 h-1.5 bg-border">
        <div className="absolute inset-y-0 left-0 bg-primary/30" style={{ width: `${entryAt}%` }} />
        <span className="absolute -top-1 h-3.5 w-px bg-foreground/60" style={{ left: `${entryAt}%` }} title="вход" />
        <span className={`absolute -top-1 h-3.5 w-px ${s.tp1_hit ? "bg-up" : "bg-up/50"}`} style={{ left: `${tp1At}%` }} title="тейк 1" />
        {p !== null && <span className="absolute -top-1.5 size-4 -translate-x-1/2 rounded-full border-2 border-background bg-foreground" style={{ left: `${p}%` }} />}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 font-mono text-xs">
        <div><p className="label">Стоп</p><p className="text-down">{price(s.tp1_hit ? s.entry : s.stop)}</p></div>
        <div><p className="label">Вход</p><p>{price(s.entry)}</p></div>
        <div><p className="label">Тейк 1</p><p className="text-up">{price(s.tp1)}{s.tp1_hit ? " ✓" : ""}</p></div>
        <div><p className="label">Тейк 2</p><p className="text-up">{price(s.tp2)}</p></div>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        Блок {price(s.block_bottom)}–{price(s.block_top)} · стоп {s.risk_pct.toFixed(1)}% · {s.targets_source === "structure" ? "тейки по структуре" : "тейки 2R/3R"}
        {s.tp1_hit ? " · половина зафиксирована, стоп в безубытке" : ""} · цена {price(s.last_price)}
      </p>
    </div>
  );
}

export default function Tracker() {
  const { data } = usePoll<{ signals: Signal[] }>("/nh/signals?status=open&limit=200");
  const rows = data?.signals ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Текущая цена — закрытие последней 30-минутной свечи. Результат с учётом фиксации половины на тейке 1, без комиссий.</p>
      {!data ? <Panel><Empty>Загрузка…</Empty></Panel> : !rows.length ? <Panel><Empty>Открытых сделок нет.</Empty></Panel> : (
        <div className="grid gap-3 lg:grid-cols-2">{rows.map((s) => <Card key={s.id} s={s} />)}</div>
      )}
    </div>
  );
}
