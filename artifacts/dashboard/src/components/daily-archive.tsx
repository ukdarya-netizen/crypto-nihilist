import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Panel, openHistory } from "./ui";
import { fmtHours, signed, tone, usePoll, when } from "../lib/api";
import { CoinLink } from "./chart";
import { SideTag } from "./ui";
import { Status, type HistoryRow } from "./signal-history";

/** Owner 2026-11-20: a day of the calendar shows its closed trades — when each opened, closed and how long it ran. */
function DayTrades({ day, live, onClose }: { day: string; live: boolean; onClose: () => void }) {
  const { data } = usePoll<{ signals: HistoryRow[]; totals?: { closed: number; pnlPct: number; r: number } }>(`/nh/history?day=${day}&limit=2000${live ? "&live=1" : ""}`, 60_000);
  const rows = data?.signals ?? [];
  const t = data?.totals;
  const hours = (r: HistoryRow) => r.closed_at ? (new Date(r.closed_at).getTime() - new Date(r.opened_at).getTime()) / 3_600_000 : null;
  return (
    <div className="mt-3 border border-primary/40 bg-black/20 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
        <span className="font-semibold">{`${day.slice(8)}.${day.slice(5, 7)}.${day.slice(0, 4)}`} · закрыто {t?.closed ?? "…"} · <span className={tone(t?.pnlPct)}>{signed(t?.pnlPct, 2, "%")}</span> · {signed(t?.r, 2, "R")}</span>
        <span className="flex gap-3">
          <button type="button" onClick={() => openHistory({ day, live })} className="text-primary underline">открыть в истории</button>
          <button type="button" onClick={onClose} className="text-muted hover:text-foreground">закрыть ×</button>
        </span>
      </div>
      {!data ? <p className="text-xs text-muted">Загрузка…</p> : !rows.length ? <p className="text-xs text-muted">В этот день сделки не закрывались.</p> : (
        <div className="-mx-3 overflow-x-auto px-3">
          <table className="w-full min-w-[640px] text-xs">
            <thead><tr className="text-left">{["Монета", "Сетап", "Открыта", "Закрыта", "Длилась", "Результат", "Статус"].map((h) => <th key={h} className="label pb-1.5 pr-3 font-normal">{h}</th>)}</tr></thead>
            <tbody className="tabular">
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1.5 pr-3 font-sans font-semibold"><span className="flex items-center gap-1.5"><CoinLink symbol={r.symbol} signal={r} /><SideTag side={r.side} /></span></td>
                  <td className="whitespace-nowrap pr-3 text-muted">{r.htf === "1d" ? "1D" : r.htf} → {r.ltf}</td>
                  <td className="whitespace-nowrap pr-3">{when(r.opened_at)}</td>
                  <td className="whitespace-nowrap pr-3">{when(r.closed_at)}</td>
                  <td className="whitespace-nowrap pr-3">{fmtHours(hours(r))}</td>
                  <td className={`pr-3 ${tone(r.pnl_pct)}`}>{signed(r.pnl_pct, 2, "%")}</td>
                  <td><Status s={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Day = { day: string; trades: number; wins: number; sum_r: number; sum_pnl_pct: number };
const WEEK = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/**
 * Month calendar of daily results by close day (AltBullet "Архив статистики").
 * Owner 2026-11-20: follows the «all setups / channel only» switch; a day (or the month line) opens its trades.
 */
export function DailyArchive({ live = false }: { live?: boolean }) {
  const { data } = usePoll<{ daily: Day[] }>(`/nh/stats/daily?days=400${live ? "&live=1" : ""}`, 120_000);
  const now = new Date();
  const [month, setMonth] = useState(() => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const byDay = new Map((data?.daily ?? []).map((d) => [d.day, d]));
  const y = month.getUTCFullYear(); const m = month.getUTCMonth();
  const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];
  const monthRows = [...byDay.values()].filter((d) => d.day.startsWith(`${y}-${String(m + 1).padStart(2, "0")}`));
  const total = monthRows.reduce((a, d) => a + d.sum_pnl_pct, 0);
  const totalR = monthRows.reduce((a, d) => a + d.sum_r, 0);
  const trades = monthRows.reduce((a, d) => a + d.trades, 0);
  const shift = (k: number) => setMonth(new Date(Date.UTC(y, m + k, 1)));
  const [pick, setPick] = useState<string | null>(null);
  return (
    <Panel title="Архив по дням" right={
      <div className="flex items-center gap-2 font-mono text-xs">
        <button type="button" onClick={() => shift(-1)} aria-label="Предыдущий месяц" className="p-1 text-muted hover:text-foreground"><ChevronLeft className="size-4" /></button>
        <span className="w-32 text-center">{month.toLocaleString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })}</span>
        <button type="button" onClick={() => shift(1)} aria-label="Следующий месяц" className="p-1 text-muted hover:text-foreground"><ChevronRight className="size-4" /></button>
      </div>
    }>
      <div className="grid grid-cols-7 gap-1 font-mono text-[10px]">
        {WEEK.map((w) => <div key={w} className="pb-1 text-center text-muted">{w}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const row = byDay.get(key);
          const v = row?.sum_pnl_pct ?? null;
          return (
            <div key={key} title={row ? `${key}: ${row.trades} сделок, в плюс ${row.wins}, ${signed(row.sum_pnl_pct, 2, "%")} · ${signed(row.sum_r, 2, "R")}` : key}
              role={row ? "button" : undefined} onClick={row ? () => setPick(pick === key ? null : key) : undefined}
              className={`flex aspect-square flex-col justify-between border p-1 md:aspect-auto md:h-16 ${v === null ? "border-border/50 text-muted/60" : v >= 0 ? "cursor-pointer border-up/40 bg-up/10 hover:border-up" : "cursor-pointer border-down/40 bg-down/10 hover:border-down"} ${pick === key ? "ring-1 ring-primary" : ""}`}>
              <span className="text-muted">{d}</span>
              {row && <span className={`text-right text-[11px] ${v! >= 0 ? "text-up" : "text-down"}`}>{signed(v, 1, "%")}<span className="hidden text-muted md:inline"> · {row.trades}</span></span>}
            </div>
          );
        })}
      </div>
      {pick && <DayTrades day={pick} live={live} onClose={() => setPick(null)} />}
      <p role="link" onClick={() => openHistory({ month: `${y}-${String(m + 1).padStart(2, "0")}`, live })} className="mt-3 cursor-pointer font-mono text-xs text-muted hover:text-foreground">За месяц: {trades} закрытых · <span className={total >= 0 ? "text-up" : "text-down"}>{signed(total, 2, "%")}</span> · {signed(totalR, 2, "R")} (по дню закрытия, UTC)</p>
    </Panel>
  );
}
