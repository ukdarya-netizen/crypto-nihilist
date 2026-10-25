import { Empty, Panel, SideTag } from "../components/ui";
import { coin, livePct, price, setupLabel, signed, tone, usePoll, when, type Signal } from "../lib/api";

const TRAIL_AT = 15;

function Card({ s }: { s: Signal }) {
  const live = livePct(s);
  const dir = s.side === "long" ? 1 : -1;
  const pct = (p: number) => ((p - s.entry) / s.entry) * 100 * dir;
  const stopNow = s.current_stop ?? s.stop;
  // Scale in % of entry: from the original stop to the furthest of TP1, +15% (trailing) and the peak.
  const lo = pct(s.stop);
  const hi = Math.max(pct(s.tp1), TRAIL_AT, s.peak_pct) * 1.08;
  const at = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  const now = live ?? null;
  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {coin(s.symbol)} <SideTag side={s.side} />
            {!s.live && <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">тень</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted">{setupLabel(s.setup)} · {s.block_scope === "swing" ? "swing-блок" : "internal-блок"}</p>
        </div>
        <div className="text-right">
          <p className={`font-mono text-xl font-semibold ${tone(live)}`}>{signed(live, 2, "%")}</p>
          <p className="text-[11px] text-muted">открыта {when(s.opened_at)}</p>
        </div>
      </div>
      <div className="relative mt-5 h-1.5 bg-border">
        <div className="absolute inset-y-0 bg-primary/35" style={{ left: 0, width: at(pct(stopNow)) }} />
        <span className="absolute -top-1 h-3.5 w-px bg-foreground/60" style={{ left: at(0) }} title="вход" />
        <span className={`absolute -top-1 h-3.5 w-px ${s.tp1_hit ? "bg-up" : "bg-up/50"}`} style={{ left: at(pct(s.tp1)) }} title="тейк 1" />
        <span className={`absolute -top-1 h-3.5 w-px ${s.trailing_active ? "bg-primary" : "bg-primary/50"}`} style={{ left: at(TRAIL_AT) }} title="трейлинг +15%" />
        {s.peak_pct > 0 && <span className="absolute top-0 h-1.5 w-0.5 bg-up/80" style={{ left: at(s.peak_pct) }} title="пик" />}
        {now !== null && <span className="absolute -top-1.5 size-4 -translate-x-1/2 rounded-full border-2 border-background bg-foreground" style={{ left: at(now) }} />}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 font-mono text-xs">
        <div><p className="label">{s.trailing_active ? "Трейлинг" : "Стоп"}</p><p className="text-down">{price(stopNow)}</p><p className="text-[10px] text-muted">{signed(pct(stopNow), 1, "%")}</p></div>
        <div><p className="label">Вход</p><p>{price(s.entry)}</p></div>
        <div><p className="label">Тейк 1</p><p className="text-up">{price(s.tp1)}{s.tp1_hit ? " ✓" : ""}</p><p className="text-[10px] text-muted">{signed(pct(s.tp1), 1, "%")}</p></div>
        <div><p className="label">Пик</p><p className="text-up">{signed(s.peak_pct, 1, "%")}</p></div>
      </div>
      <p className="mt-3 text-[11px] text-muted">
        Блок {price(s.block_bottom)}–{price(s.block_top)} · стоп при входе {s.risk_pct.toFixed(1)}%
        {s.tp1_hit ? " · половина зафиксирована на тейке 1" : ""}
        {s.trailing_active ? " · трейлинг идёт: пик − 10 п.п." : " · трейлинг с +15%"} · цена {price(s.last_price)}
      </p>
    </div>
  );
}

export default function Tracker() {
  const { data } = usePoll<{ signals: Signal[] }>("/nh/signals?status=open&limit=200");
  const rows = data?.signals ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Сделки ведутся по 5-минутным свечам. Результат — движение цены от входа, без комиссий. «Тень» — сетап ещё не публикуется в Telegram.</p>
      {!data ? <Panel><Empty>Загрузка…</Empty></Panel> : !rows.length ? <Panel><Empty>Открытых сделок нет.</Empty></Panel> : (
        <div className="grid gap-3 lg:grid-cols-2">{rows.map((s) => <Card key={s.id} s={s} />)}</div>
      )}
    </div>
  );
}
