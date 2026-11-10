import { useState } from "react";
import { Copy, Download, Loader2, Play } from "lucide-react";
import { currentSession, post, usePoll } from "../lib/api";

type Resp = {
  running: boolean;
  report: { status: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; error: string | null; progress: { done: number; total: number; stage?: string } } | null;
  text: string | null;
};
const dt = (s: string | null) => (s ? new Date(s).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Dubai" }) : "—");

/** An owner-only study (owner 2026-11-10): start, progress, text report, CSV. */
function StudyPanel({ path, title, about, file }: { path: string; title: string; about: string; file: string }) {
  const { data } = usePoll<Resp>(path, 15_000);
  const [msg, setMsg] = useState<string | null>(null);
  const r = data?.report ?? null;
  const running = Boolean(data?.running) || r?.status === "running";
  const start = async () => {
    try { await post(`${path}/run`, {}); setMsg("Запущено"); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setTimeout(() => setMsg(null), 4000);
  };
  const copy = async () => {
    if (!data?.text) return;
    try { await navigator.clipboard.writeText(data.text); setMsg("Скопировано"); } catch { setMsg("Буфер обмена недоступен"); }
    setTimeout(() => setMsg(null), 3000);
  };
  const csv = async () => {
    const token = currentSession()?.token;
    const res = await fetch(`/api${path}/csv`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) { setMsg("CSV ещё не готов"); setTimeout(() => setMsg(null), 3000); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = `${file}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="panel space-y-3 p-4 text-sm">
      <p className="font-semibold">{title}</p>
      <p className="text-xs text-muted">{about}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void start()} disabled={running}
          className="flex h-9 items-center gap-2 border border-primary bg-primary px-3 text-xs font-bold uppercase text-white disabled:opacity-50">
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}{running ? "Считается…" : r ? "Пересчитать" : "Запустить"}
        </button>
        {data?.text && <button type="button" onClick={() => void copy()} className="flex h-9 items-center gap-2 border border-border px-3 text-xs"><Copy className="size-4" />Копировать отчёт текстом</button>}
        {r?.status === "done" && <button type="button" onClick={() => void csv()} className="flex h-9 items-center gap-2 border border-border px-3 text-xs"><Download className="size-4" />Сделки по вариантам (CSV)</button>}
        {r && <span className="text-xs text-muted">
          {r.status === "running" && `${r.progress.stage ? `${r.progress.stage} · ` : ""}${r.progress.done} из ${r.progress.total} · `}
          {r.status === "failed" && <span className="text-down">ошибка: {r.error} · </span>}
          начат {dt(r.startedAt)}{r.finishedAt ? ` · готов ${dt(r.finishedAt)}` : ""}
        </span>}
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </div>
  );
}

export function SmcStudyPanel() {
  return <StudyPanel path="/nh/smc-study" file="nihilist-smc-study" title="SMC: уточнённый вход и цели по ликвидности"
    about="Те же сигналы с другим входом (ретест ОБ младшего ТФ, FVG или 50% движения слома; ждём 2, 4 или 8 свечей) и другими целями (ликвидность младшего и старшего ТФ, equal highs/lows, половина на первой цели). Бэктест 60 дней по всем парам и реальные сигналы по названию, лонги и шорты отдельно. Сигналы и сделки не меняет. Идёт 1–2,5 часа после сканирования." />;
}

export function BtcStudyPanel() {
  return <StudyPanel path="/nh/btc-study" file="nihilist-btc-study" title="BTC: свой стоп и выход"
    about="BTC и для сравнения ETH на истории до 2 лет, все 8 сетапов, лонги и шорты: запас стопа 0–3%, безубыток, тейк, трейлинг, цели в R и сегодняшние правила альтов. Результат в % цены и в % маржи при 10x и 50x. Сигналы и сделки не меняет. Идёт около часа." />;
}
