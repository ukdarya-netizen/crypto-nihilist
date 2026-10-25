import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Panel } from "./ui";
import { signed, usePoll } from "../lib/api";

type Day = { day: string; trades: number; wins: number; sum_r: number; sum_pnl_pct: number };
const WEEK = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** Month calendar of daily results by close day (AltBullet "Архив статистики"). */
export function DailyArchive() {
  const { data } = usePoll<{ daily: Day[] }>("/nh/stats/daily?days=400", 120_000);
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
              className={`flex aspect-square flex-col justify-between border p-1 md:aspect-auto md:h-16 ${v === null ? "border-border/50 text-muted/60" : v >= 0 ? "border-up/40 bg-up/10" : "border-down/40 bg-down/10"}`}>
              <span className="text-muted">{d}</span>
              {row && <span className={`text-right text-[11px] ${v! >= 0 ? "text-up" : "text-down"}`}>{signed(v, 1, "%")}<span className="hidden text-muted md:inline"> · {row.trades}</span></span>}
            </div>
          );
        })}
      </div>
      <p className="mt-3 font-mono text-xs text-muted">За месяц: {trades} закрытых · <span className={total >= 0 ? "text-up" : "text-down"}>{signed(total, 2, "%")}</span> · {signed(totalR, 2, "R")} (по дню закрытия, UTC)</p>
    </Panel>
  );
}
