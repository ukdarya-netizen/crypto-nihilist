import { useState } from "react";
import { Copy, Download, Loader2, Play } from "lucide-react";
import { currentSession, post, usePoll } from "../lib/api";

type Resp = {
  running: boolean;
  report: { status: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; error: string | null; progress: { done: number; total: number } } | null;
  text: string | null;
};
const dt = (s: string | null) => (s ? new Date(s).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Dubai" }) : "—");

/** SMC study (owner 2026-11-10): refined entry on a retest and targets at liquidity — start, progress, text, CSV. */
export function SmcStudyPanel() {
  const { data } = usePoll<Resp>("/nh/smc-study", 15_000);
  const [msg, setMsg] = useState<string | null>(null);
  const r = data?.report ?? null;
  const running = Boolean(data?.running) || r?.status === "running";
  const start = async () => {
    try { await post("/nh/smc-study/run", {}); setMsg("Запущено"); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setTimeout(() => setMsg(null), 4000);
  };
  const copy = async () => {
    if (!data?.text) return;
    try { await navigator.clipboard.writeText(data.text); setMsg("Скопировано"); } catch { setMsg("Буфер обмена недоступен"); }
    setTimeout(() => setMsg(null), 3000);
  };
  const csv = async () => {
    const token = currentSession()?.token;
    const res = await fetch("/api/nh/smc-study/csv", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { setMsg("CSV ещё не готов"); setTimeout(() => setMsg(null), 3000); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = `nihilist-smc-study-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="panel space-y-3 p-4 text-sm">
      <p className="font-semibold">SMC: уточнённый вход и цели по ликвидности</p>
      <p className="text-xs text-muted">
        Те же сигналы с другим входом (ретест ОБ младшего ТФ, FVG или 50% движения слома; ждём 2, 4 или 8 свечей) и другими целями
        (ликвидность младшего и старшего ТФ, equal highs/lows, половина на первой цели). Бэктест 60 дней по всем парам и реальные сигналы по названию,
        лонги и шорты отдельно. Сигналы и сделки не меняет. Идёт 1–2,5 часа после сканирования.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void start()} disabled={running}
          className="flex h-9 items-center gap-2 border border-primary bg-primary px-3 text-xs font-bold uppercase text-white disabled:opacity-50">
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}{running ? "Считается…" : r ? "Пересчитать" : "Запустить"}
        </button>
        {data?.text && <button type="button" onClick={() => void copy()} className="flex h-9 items-center gap-2 border border-border px-3 text-xs"><Copy className="size-4" />Копировать отчёт текстом</button>}
        {r?.status === "done" && <button type="button" onClick={() => void csv()} className="flex h-9 items-center gap-2 border border-border px-3 text-xs"><Download className="size-4" />Сделки по вариантам (CSV)</button>}
        {r && <span className="text-xs text-muted">
          {r.status === "running" && `монет ${r.progress.done} из ${r.progress.total} · `}
          {r.status === "failed" && <span className="text-down">ошибка: {r.error} · </span>}
          начат {dt(r.startedAt)}{r.finishedAt ? ` · готов ${dt(r.finishedAt)}` : ""}
        </span>}
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </div>
  );
}
