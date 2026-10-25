import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Empty, Kpi, Panel, Segmented, SideTag } from "../components/ui";
import { CoinLink } from "../components/chart";
import { SnapshotPanel } from "../components/snapshot";
import { METRIC_COLUMNS, MetricCell } from "../components/metric-columns";
import { Trajectory } from "../components/trajectory";
import { fmtHours, livePct, price, setupLabel, signed, tone, usePoll, when, type Signal } from "../lib/api";

const TRAIL_AT = 15;

function Card({ s }: { s: Signal }) {
  const [more, setMore] = useState(false);
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
            <CoinLink symbol={s.symbol} signal={s} /> <SideTag side={s.side} />
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
        {" · в сделке "}{fmtHours((Date.now() - new Date(s.opened_at).getTime()) / 3_600_000)}
      </p>
      <button type="button" onClick={() => setMore((v) => !v)} className="mt-2 flex items-center gap-1 font-mono text-[11px] text-muted hover:text-foreground">
        <ChevronDown className={`size-3.5 transition ${more ? "rotate-180" : ""}`} />метрики при сигнале
      </button>
      {more && <div className="mt-2 border-t border-border pt-2 text-xs"><SnapshotPanel snapshot={s.snapshot} reconstructed={s.snapshot_reconstructed} status={s.snapshot_status} /></div>}
    </div>
  );
}

type Sort = "pnl" | "time" | "peak";

/** One open trade as a list row (AltBullet "Открытые позиции"); click to expand. */
function Row({ s, open, onToggle }: { s: Signal; open: boolean; onToggle: () => void }) {
  const live = livePct(s);
  const dir = s.side === "long" ? 1 : -1;
  const pct = (p: number) => ((p - s.entry) / s.entry) * 100 * dir;
  const stopNow = s.current_stop ?? s.stop;
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-border hover:bg-white/[0.02]">
        <td className="whitespace-nowrap py-2.5 pr-3 text-muted">{when(s.opened_at)}</td>
        <td className="pr-3 font-sans"><span className="flex items-center gap-2"><CoinLink symbol={s.symbol} signal={s} /><SideTag side={s.side} />{!s.live && <span className="text-[10px] text-muted">тень</span>}</span></td>
        <td className="whitespace-nowrap pr-3 font-sans text-xs text-muted">{setupLabel(s.setup)}</td>
        <td className="pr-3">{price(s.entry)}</td>
        <td className="pr-3">{price(s.last_price)}</td>
        <td className={`pr-3 font-semibold ${tone(live)}`}>{signed(live, 2, "%")}</td>
        <td className="pr-3 text-up">{signed(s.peak_pct, 1, "%")}</td>
        <td className="whitespace-nowrap pr-3 text-down">{price(stopNow)} <span className="text-[10px] text-muted">{signed(pct(stopNow), 1, "%")}</span></td>
        <td className="pr-3 text-up">{price(s.tp1)}{s.tp1_hit ? " ✓" : ""}</td>
        <td className="whitespace-nowrap pr-3 text-xs">{s.trailing_active ? <span className="text-primary">трейлинг</span> : s.tp1_hit ? "тейк 1 взят" : "ждёт тейк 1"}</td>
        <td className="pr-3 text-muted">{fmtHours((Date.now() - new Date(s.opened_at).getTime()) / 3_600_000)}</td>
        {METRIC_COLUMNS.map((c) => <MetricCell key={c.key} snapshot={s.snapshot} col={c} />)}
        <td><ChevronDown className={`size-4 text-muted transition ${open ? "rotate-180" : ""}`} /></td>
      </tr>
      {open && (
        <tr><td colSpan={12 + METRIC_COLUMNS.length} className="p-0">
          <div className="grid gap-4 border-t border-border bg-black/20 p-4 text-xs lg:grid-cols-2">
            <div><Card s={s} /></div>
            <div><p className="label mb-2">Траектория: рынок после входа</p><Trajectory id={s.id} /></div>
            <div className="lg:col-span-2"><p className="label mb-2">Метрики при сигнале</p>
              <SnapshotPanel snapshot={s.snapshot} reconstructed={s.snapshot_reconstructed} status={s.snapshot_status} /></div>
          </div>
        </td></tr>
      )}
    </>
  );
}

export default function Tracker() {
  const { data } = usePoll<{ signals: Signal[] }>("/nh/signals?status=open&limit=500");
  const [side, setSide] = useState<"" | "long" | "short">("");
  const [sort, setSort] = useState<Sort>("time");
  const [openId, setOpenId] = useState<number | null>(null);
  const all = data?.signals ?? [];
  const rows = all.filter((s) => !side || s.side === side).sort((a, b) =>
    sort === "pnl" ? (livePct(b) ?? -1e9) - (livePct(a) ?? -1e9)
      : sort === "peak" ? b.peak_pct - a.peak_pct
        : new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
  const lives = all.map(livePct).filter((v): v is number => v !== null);
  const plus = lives.filter((v) => v > 0).length;
  const avg = lives.length ? lives.reduce((a, b) => a + b, 0) / lives.length : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Открыто позиций" value={data ? all.length : "—"} hint={data ? `лонг ${all.filter((s) => s.side === "long").length} · шорт ${all.filter((s) => s.side === "short").length}` : undefined} />
        <Kpi label="В плюсе / в минусе" value={data ? `${plus} / ${lives.length - plus}` : "—"} toneClass={plus >= lives.length - plus ? "text-up" : "text-down"} />
        <Kpi label="Средний результат" value={signed(avg, 2, "%")} toneClass={tone(avg)} hint="движение цены от входа" />
        <Kpi label="Тейк 1 взят / трейлинг" value={data ? `${all.filter((s) => s.tp1_hit).length} / ${all.filter((s) => s.trailing_active).length}` : "—"} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Сделки ведутся по 5-минутным свечам. Метрики — на момент сигнала; нажми строку — карточка, траектория и все метрики.</p>
        <div className="flex flex-wrap gap-2">
          <Segmented value={side} onChange={(id) => setSide(id as "" | "long" | "short")} options={[{ id: "", label: "все" }, { id: "long", label: "лонг" }, { id: "short", label: "шорт" }]} />
          <Segmented value={sort} onChange={(id) => setSort(id as Sort)} options={[{ id: "time", label: "новые" }, { id: "pnl", label: "по %" }, { id: "peak", label: "по пику" }]} />
        </div>
      </div>
      <Panel title={`Открытые позиции · ${rows.length}`}>
        {!data ? <Empty>Загрузка…</Empty> : !rows.length ? <Empty>Открытых сделок нет.</Empty> : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[1500px] text-sm">
                <thead><tr className="text-left">{["Открыта", "Монета", "Сетап", "Вход", "Цена", "Результат", "Пик", "Стоп", "Тейк 1", "Этап", "В сделке", ...METRIC_COLUMNS.map((c) => c.head), ""].map((h) => <th key={h} className="label whitespace-nowrap pb-2 pr-3 font-normal">{h}</th>)}</tr></thead>
                <tbody className="tabular">{rows.map((s) => <Row key={s.id} s={s} open={openId === s.id} onToggle={() => setOpenId(openId === s.id ? null : s.id)} />)}</tbody>
              </table>
            </div>
            <div className="grid gap-3 md:hidden">{rows.map((s) => <Card key={s.id} s={s} />)}</div>
          </>
        )}
      </Panel>
    </div>
  );
}
