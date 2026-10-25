import { Fragment, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Empty, Panel, SideTag } from "./ui";
import { CoinLink } from "./chart";
import { SnapshotPanel } from "./snapshot";
import { coin, get, price, SETUPS, setupLabel, signed, tone, usePoll, when, type Signal } from "../lib/api";

export type TradeStatus = "profit" | "be_stop" | "stop_loss" | "expired" | "open";
export type HistoryRow = Signal & { trade_status: TradeStatus };

export const STATUS_META: Record<TradeStatus, { label: string; cls: string }> = {
  open: { label: "В РАБОТЕ", cls: "border-warn/40 text-warn" },
  profit: { label: "PROFIT", cls: "border-up/50 bg-up/10 text-up" },
  be_stop: { label: "BE STOP", cls: "border-sky-400/40 text-sky-300" },
  stop_loss: { label: "STOP LOSS", cls: "border-down/50 bg-down/10 text-down" },
  expired: { label: "EXPIRED", cls: "border-border text-muted" },
};

const EVENT_LABEL: Record<string, string> = {
  opened: "Сигнал", milestone: "Уровень", breakeven: "Стоп в безубыток", tp1: "Тейк 1 (50%)",
  trailing_on: "Трейлинг включён", closed: "Закрыта",
};

type Event = { id: number; kind: string; price: number | null; detail: Record<string, unknown>; created_at: string; telegram_sent_at: string | null };

function duration(from: string, to: string | null): string {
  const ms = Math.max(0, (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime());
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}д ${h % 24}ч` : h ? `${h}ч` : `${Math.round(ms / 60_000)}м`;
}

/** Result shown in the list: closed = net % with TP1 half and fees; open = price move now. */
function resultPct(s: HistoryRow): number | null {
  if (s.status === "closed") return s.pnl_pct;
  if (s.last_price === null) return null;
  return ((Number(s.last_price) - s.entry) / s.entry) * 100 * (s.side === "long" ? 1 : -1);
}

export const STATUS_HELP: Record<TradeStatus, string> = {
  open: "Сделка открыта и сопровождается по 5-минутным свечам.",
  profit: "Закрыта в плюс: трейлингом или по времени удержания с прибылью.",
  be_stop: "Закрыта стопом на входе (после тейка 1 или безубытка). +5/+8/+10 — до какого пика дошла.",
  stop_loss: "Сработал структурный стоп (за реакцией от блока, ещё на 3% дальше).",
  expired: "Закрыта по времени удержания в ноль или минус (7 дней для ОБ 4h, 21 день для ОБ 1D).",
};

function Status({ s }: { s: HistoryRow }) {
  const meta = STATUS_META[s.trade_status];
  const extra = s.trade_status === "be_stop" ? ` ${s.peak_pct >= 10 ? "+10" : s.peak_pct >= 8 ? "+8" : s.peak_pct >= 5 ? "+5" : ""}` : "";
  return <span title={STATUS_HELP[s.trade_status]} className={`whitespace-nowrap border px-1.5 py-0.5 font-mono text-[10px] ${meta.cls}`}>{meta.label}{extra}</span>;
}

function Details({ s }: { s: HistoryRow }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  if (events === null) void get<{ events: Event[] }>(`/nh/signals/${s.id}/events`).then((d) => setEvents(d.events)).catch(() => setEvents([]));
  const pct = (p: number) => ((p - s.entry) / s.entry) * 100 * (s.side === "long" ? 1 : -1);
  return (
    <div className="grid gap-4 border-t border-border bg-black/20 p-4 text-xs md:grid-cols-2">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono">
        <dt className="text-muted">Ордер-блок</dt><dd>{price(s.block_bottom)} – {price(s.block_top)} <span className="text-muted">({s.block_scope})</span></dd>
        <dt className="text-muted">Вход</dt><dd>{price(s.entry)}</dd>
        <dt className="text-muted">Стоп</dt><dd className="text-down">{price(s.stop)} ({signed(pct(s.stop), 1, "%")})</dd>
        <dt className="text-muted">Тейк 1</dt><dd className="text-up">{price(s.tp1)} ({signed(pct(s.tp1), 1, "%")}){s.tp1_hit ? " ✓" : ""}</dd>
        <dt className="text-muted">Стоп сейчас</dt><dd>{s.current_stop !== null ? `${price(s.current_stop)} (${signed(pct(s.current_stop), 1, "%")})` : "—"}</dd>
        <dt className="text-muted">Пик / просадка</dt><dd>{signed(s.peak_pct, 1, "%")} / {signed(s.mae_pct, 1, "%")}</dd>
        <dt className="text-muted">R</dt><dd className={tone(s.r_multiple)}>{signed(s.r_multiple)}</dd>
        <dt className="text-muted">Telegram</dt><dd>{s.live ? "в канале" : "тень (не публикуется)"}</dd>
      </dl>
      <div className="md:col-span-2 md:order-last">
        <p className="label mb-2">Метрики при сигнале</p>
        <SnapshotPanel snapshot={s.snapshot} close={s.close_context} reconstructed={s.snapshot_reconstructed} status={s.snapshot_status} />
      </div>
      <div>
        <p className="label mb-2">Ход сделки</p>
        {events === null ? <p className="text-muted">Загрузка…</p> : !events.length ? <p className="text-muted">Событий нет.</p> : (
          <ol className="space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-24 shrink-0 font-mono text-muted">{when(e.created_at)}</span>
                <span className="flex-1">
                  {e.kind === "milestone" ? `${EVENT_LABEL.milestone} ${signed(Number(e.detail.milestone), 0, "%")}` : EVENT_LABEL[e.kind] ?? e.kind}
                  {e.kind === "closed" && ` · ${signed(Number(e.detail.pnlPct), 2, "%")}`}
                </span>
                <span className="font-mono text-muted">{e.price !== null ? price(e.price) : ""}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const FILTERS: Array<{ id: "" | TradeStatus; label: string }> = [
  { id: "", label: "Все" }, { id: "open", label: "В работе" }, { id: "profit", label: "PROFIT" },
  { id: "be_stop", label: "BE STOP" }, { id: "stop_loss", label: "STOP LOSS" }, { id: "expired", label: "EXPIRED" },
];

export function SignalHistory({ days, live, status, onStatus, limit = 200, title = "История сигналов" }: {
  days: number; live: boolean; status: "" | TradeStatus; onStatus: (s: "" | TradeStatus) => void; limit?: number; title?: string;
}) {
  const [setup, setSetup] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const params = new URLSearchParams({ days: String(days), limit: String(limit) });
  if (live) params.set("live", "1");
  if (setup) params.set("setup", setup);
  if (status) params.set("status", status);
  if (q.trim()) params.set("q", q.trim());
  const { data } = usePoll<{ signals: HistoryRow[] }>(`/nh/history?${params}`, 30_000);
  const rows = data?.signals ?? [];
  return (
    <Panel title={`${title} · ${rows.length}`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap border border-border">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" onClick={() => onStatus(f.id)}
              className={`px-2.5 py-1.5 font-mono text-[11px] ${status === f.id ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={setup} onChange={(e) => setSetup(e.target.value)} className="h-8 border border-border bg-background px-2 text-xs">
          <option value="">Все сетапы</option>
          {SETUPS.map((s) => <option key={s} value={s}>{setupLabel(s)}</option>)}
        </select>
        <label className="flex h-8 items-center gap-2 border border-border px-2 text-xs">
          <Search className="size-3.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Монета" className="w-24 bg-transparent outline-none" />
        </label>
      </div>
      {!rows.length ? <Empty>{data ? "Сигналов с такими условиями нет." : "Загрузка…"}</Empty> : (
        <>
          {/* Phones: cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((s) => {
              const r = resultPct(s);
              return (
                <li key={s.id} className="border border-border">
                  <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} className="w-full p-3 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-semibold"><CoinLink symbol={s.symbol} signal={s} /> <SideTag side={s.side} /></span>
                      <Status s={s} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted">
                      <span>{setupLabel(s.setup)}</span>
                      <span className={`font-mono text-sm ${tone(r)}`}>{signed(r, 2, "%")}</span>
                    </div>
                    <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
                      <span>{when(s.opened_at)} · {duration(s.opened_at, s.closed_at)}</span>
                      <span>пик {signed(s.peak_pct, 1, "%")}</span>
                    </div>
                  </button>
                  {open === s.id && <Details s={s} />}
                </li>
              );
            })}
          </ul>
          {/* Desktop: table */}
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">{["Открыт", "Монета", "Сетап", "Вход", "Сейчас / выход", "Пик", "Результат", "R", "Статус", "Время", ""].map((h) => <th key={h} className="label pb-2 pr-3 font-normal">{h}</th>)}</tr>
              </thead>
              <tbody className="tabular">
                {rows.map((s) => {
                  const r = resultPct(s);
                  const isOpen = open === s.id;
                  return (
                    <Fragment key={s.id}>
                      <tr onClick={() => setOpen(isOpen ? null : s.id)} className="cursor-pointer border-t border-border hover:bg-white/[0.02]">
                        <td className="py-2.5 pr-3 text-muted">{when(s.opened_at)}</td>
                        <td className="pr-3 font-sans font-semibold"><span className="flex items-center gap-2"><CoinLink symbol={s.symbol} signal={s} /> <SideTag side={s.side} />{!s.live && <span className="font-mono text-[10px] font-normal text-muted">тень</span>}</span></td>
                        <td className="pr-3 font-sans text-xs text-muted">{setupLabel(s.setup)}</td>
                        <td className="pr-3">{price(s.entry)}</td>
                        <td className="pr-3">{price(s.status === "closed" ? s.exit_price : s.last_price)}</td>
                        <td className="pr-3 text-up">{signed(s.peak_pct, 1, "%")}</td>
                        <td className={`pr-3 font-semibold ${tone(r)}`}>{signed(r, 2, "%")}</td>
                        <td className={`pr-3 ${tone(s.r_multiple)}`}>{s.status === "closed" ? signed(s.r_multiple) : "—"}</td>
                        <td className="pr-3"><Status s={s} /></td>
                        <td className="pr-3 text-muted">{duration(s.opened_at, s.closed_at)}</td>
                        <td><ChevronDown className={`size-4 text-muted transition ${isOpen ? "rotate-180" : ""}`} /></td>
                      </tr>
                      {isOpen && <tr><td colSpan={11} className="p-0"><Details s={s} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
