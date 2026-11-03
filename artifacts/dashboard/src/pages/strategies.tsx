/**
 * «Стратегии торговли» — owner only (2026-11-03): every way to manage a
 * Nihilist trade in the trading bot, on live signals and on 60 days of
 * history, longs and shorts apart. The owner starts the calculation here and
 * chooses the bot's strategy for Nihilist from it.
 */
import { Fragment, useState } from "react";
import { Copy, Loader2, Play } from "lucide-react";
import { post, usePoll } from "../lib/api";

type Stats = {
  n: number; open: number; winPct: number; stopPct: number; flatPct: number; takePct: number; trailPct: number; timeoutPct: number;
  avg: number; sum: number; pf: number | null; maxDd: number; worstStreak: number;
  half1: { n: number; avg: number | null }; half2: { n: number; avg: number | null };
  avgHoldH: number; perDay: number; buckets: Array<[string, number]>; hold: Array<[string, number]>;
};
type Group = "long_filtered" | "long_all" | "short";
type Dataset = {
  name: "live" | "history"; from: string | null; to: string | null; trades: number; symbols: number; skippedSymbols: number;
  groups: Record<Group, Array<{ id: string; label: string; stats: Stats }>>;
  filters?: Array<{ id: string; side: "long" | "short"; label: string; stats: Record<string, Stats> }>;
};
type Report = {
  status: "idle" | "running" | "done" | "failed"; startedAt: string | null; finishedAt: string | null; error: string | null;
  progress: { stage: string; done: number; total: number }; datasets: Dataset[]; parity: { checked: number; mismatched: number } | null;
};
type Resp = { running: boolean; report: Report | null; historyDays: number };

// Only what is really traded: Nihilist sends longs that pass its entry filter, and shorts.
const GROUP_LABEL: Partial<Record<Group, string>> = { long_filtered: "Лонги", short: "Шорты" };
const DS_LABEL = { history: "Бэктест 60 дней", live: "Реальные сигналы" } as const;
const TZ = "Asia/Dubai";
const dt = (s: string | null) => (s ? new Date(s).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: TZ }) : "—");
const d = (s: string | null) => (s ? new Date(s).toLocaleDateString("ru-RU", { timeZone: TZ }) : "—");
const sg = (v: number | null, digits = 2) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits).replace(".", ",")}`);
const pct = (v: number) => `${Math.round(v)}%`;
const tone = (v: number | null) => (v === null || Math.abs(v) < 1e-9 ? "" : v > 0 ? "text-up" : "text-down");
const holdText = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1).replace(".", ",")} д` : `${h.toFixed(0)} ч`);
const stable = (s: Stats) => (s.half1.avg ?? -1) > 0 && (s.half2.avg ?? -1) > 0;
const TRADED: Array<[string, string]> = [["source", "как Нигилист"], ["take5", "фикс +5%"], ["take10", "фикс +10%"], ["take15", "фикс +15%"]];

export default function Strategies() {
  const { data, error } = usePoll<Resp>("/nh/strategy-report", 10_000);
  const [ds, setDs] = useState<"history" | "live">("history");
  const [group, setGroup] = useState<Group>("long_filtered");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);

  const report = data?.report ?? null;
  const running = Boolean(data?.running) || report?.status === "running";
  const start = async () => {
    setStarting(true);
    try { await post("/nh/strategy-report/run", {}); } catch { /* the poll shows the state */ } finally { setStarting(false); }
  };
  const dataset = report?.datasets.find((x) => x.name === ds) ?? report?.datasets[0] ?? null;
  const other = report?.datasets.find((x) => x.name !== dataset?.name) ?? null;
  const rows = dataset ? [...dataset.groups[group]].sort((a, b) => b.stats.sum - a.stats.sum) : [];

  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(reportText(report)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="space-y-4">
      <div className="panel space-y-3 p-4 text-sm">
        <p>
          Каждый сигнал Нигилиста прогоняется через разные способы ведения сделки: тейки, безубыток, трейлинг, частичная фиксация.
          Два набора данных: <b>бэктест</b> — те же сетапы за последние {data?.historyDays ?? 60} дней по всем парам BingX (одна сделка на монету и сторону, как в торговом боте),
          и <b>реальные сигналы</b> — все сигналы, которые Нигилист уже выдал. Лонги и шорты отдельно.
        </p>
        <p className="text-xs text-muted">
          Результат — % хода цены за сделку с комиссиями (на марже при 10x — в 10 раз больше). Внутри свечи 30m первым проверяется стоп — оценка осторожная.
          «Устойчиво» = средний результат в плюсе и в первой, и во второй половине периода.
          Пересчёт истории занимает 20–60 минут и идёт после сканирования, сигналы не задерживает.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={start} disabled={running || starting}
            className="flex h-9 items-center gap-2 border border-primary bg-primary px-3 text-xs font-bold uppercase text-white disabled:opacity-50">
            {running || starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? "Считается…" : report ? "Пересчитать" : "Запустить расчёт"}
          </button>
          {report && report.status === "done" && (
            <button type="button" onClick={copy} className="flex h-9 items-center gap-2 border border-border px-3 text-xs">
              <Copy className="size-4" />{copied ? "Скопировано" : "Копировать отчёт текстом"}
            </button>
          )}
          {report && (
            <span className="text-xs text-muted">
              {report.status === "running" && `${report.progress.stage === "history" ? "бэктест" : "реальные сигналы"}: ${report.progress.done} из ${report.progress.total} · `}
              {report.status === "failed" && <span className="text-down">ошибка: {report.error} · </span>}
              начат {dt(report.startedAt)}{report.finishedAt ? ` · готов ${dt(report.finishedAt)}` : ""}
            </span>
          )}
          {error && <span className="text-xs text-down">{error.message}</span>}
        </div>
        {report?.parity && (
          <p className="text-xs text-muted">
            Проверка расчёта: вариант «как ведёт Нигилист» на {report.parity.checked} закрытых живых сделках без тейка совпал по причине закрытия
            в {report.parity.checked - report.parity.mismatched} (расхождения: {report.parity.mismatched} — Нигилист ведёт сделки по свечам 5m, здесь 30m).
          </p>
        )}
      </div>

      {dataset && (
        <>
          <div className="flex flex-wrap gap-2">
            {(["history", "live"] as const).filter((n) => report?.datasets.some((x) => x.name === n)).map((n) => (
              <button key={n} type="button" onClick={() => setDs(n)}
                className={`h-9 border px-3 text-xs font-bold uppercase ${dataset.name === n ? "border-primary text-primary" : "border-border text-muted"}`}>{DS_LABEL[n]}</button>
            ))}
            <span className="mx-1 w-px bg-border" />
            {(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)}
                className={`h-9 border px-3 text-xs ${group === g ? "border-foreground font-bold" : "border-border text-muted"}`}>{GROUP_LABEL[g]}</button>
            ))}
          </div>
          <p className="text-xs text-muted">
            {GROUP_LABEL[group]} · {DS_LABEL[dataset.name]}: сигналы {d(dataset.from)} — {d(dataset.to)}, всего сделок {dataset.trades}, монет {dataset.symbols}
            {dataset.skippedSymbols ? ` (без данных: ${dataset.skippedSymbols})` : ""}. Сортировка — по сумме. Клик по строке — распределение.
          </p>
          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[1100px] font-mono text-[11px]">
              <thead>
                <tr className="text-left text-muted">
                  {["Стратегия", "Сделок", "В плюс", "Стопы", "≈0", "Ср. %", "Сумма %", "PF", "Просадка", "Серия −", "1-я пол.", "2-я пол.", "Устойч.", "Ср. время", "% / день", other ? `${DS_LABEL[other.name]}: ср. / устойч.` : ""].map((h, i) =>
                    <th key={i} className="px-2 py-2 font-normal">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ id, label, stats: s }) => {
                  const o = other?.groups[group].find((x) => x.id === id)?.stats ?? null;
                  return (
                    <Fragment key={id}>
                      <tr onClick={() => setOpenRow(openRow === id ? null : id)}
                        className={`cursor-pointer border-t border-border hover:bg-card-hi ${id === "source" ? "bg-card-hi" : ""}`}>
                        <td className="px-2 py-1.5 font-sans text-xs">{label}{id === "source" && <span className="ml-1 text-primary">● сейчас</span>}</td>
                        <td className="px-2">{s.n}{s.open ? <span className="text-muted"> +{s.open} откр.</span> : null}</td>
                        <td className="px-2">{pct(s.winPct)}</td>
                        <td className="px-2">{pct(s.stopPct)}</td>
                        <td className="px-2">{pct(s.flatPct)}</td>
                        <td className={`px-2 ${tone(s.avg)}`}>{sg(s.avg)}</td>
                        <td className={`px-2 font-bold ${tone(s.sum)}`}>{sg(s.sum, 0)}</td>
                        <td className="px-2">{s.pf === null ? "—" : s.pf.toFixed(2).replace(".", ",")}</td>
                        <td className="px-2 text-down">{s.maxDd ? `−${s.maxDd.toFixed(0)}` : "0"}</td>
                        <td className="px-2">{s.worstStreak}</td>
                        <td className={`px-2 ${tone(s.half1.avg)}`}>{sg(s.half1.avg)} <span className="text-muted">({s.half1.n})</span></td>
                        <td className={`px-2 ${tone(s.half2.avg)}`}>{sg(s.half2.avg)} <span className="text-muted">({s.half2.n})</span></td>
                        <td className="px-2">{s.n ? (stable(s) ? <span className="text-up">да</span> : <span className="text-down">нет</span>) : "—"}</td>
                        <td className="px-2">{holdText(s.avgHoldH)}</td>
                        <td className={`px-2 ${tone(s.perDay)}`}>{sg(s.perDay)}</td>
                        <td className="px-2">{o ? <><span className={tone(o.avg)}>{sg(o.avg)}</span> ({o.n}) / {o.n ? (stable(o) ? <span className="text-up">да</span> : <span className="text-down">нет</span>) : "—"}</> : "—"}</td>
                      </tr>
                      {openRow === id && (
                        <tr className="border-t border-border">
                          <td colSpan={16} className="px-3 py-3">
                            <div className="grid gap-4 md:grid-cols-2">
                              <Dist title="Результат сделки (% цены)" data={s.buckets} n={s.n} />
                              <Dist title="Время в сделке" data={s.hold} n={s.n} />
                            </div>
                            <p className="mt-2 font-sans text-xs text-muted">
                              Закрытия: стоп {pct(s.stopPct)} · тейк {pct(s.takePct)} · трейлинг {pct(s.trailPct)} · по сроку {pct(s.timeoutPct)} · остальное — безубыток.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {dataset?.filters && <FilterCheck ds={dataset} />}
      {!report && !running && <p className="text-sm text-muted">Расчёт ещё не запускался.</p>}
    </div>
  );
}

/** Candidate entry filters (owner 2026-11-03): each set alone and together, for each way the trading bot leads a trade. */
function FilterCheck({ ds }: { ds: Dataset }) {
  const [m, setM] = useState("source");
  const rows = ds.filters ?? [];
  return (
    <div className="space-y-2">
      <div className="panel space-y-2 p-4 text-sm">
        <p className="font-bold">Проверка новых фильтров входа · {DS_LABEL[ds.name]}</p>
        <p className="text-xs text-muted">
          Фильтры из «Метрик входа»: ATR 30m (лонги ≥ 1.3%, шорты ≥ 1.0%), сила блока — слом за блоком ≥ 0.9 ATR, у лонгов — заход в блок ≥ 23%.
          На сигналы они пока не действуют — только этот расчёт. Каждая строка — свой поток сделок (одна сделка на монету и сторону).
          Сравнивайте строки лонгов со строкой «фильтр сейчас», шортов — со строкой «все».
        </p>
        <div className="flex flex-wrap gap-2">
          {TRADED.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setM(id)}
              className={`h-9 border px-3 text-xs ${m === id ? "border-foreground font-bold" : "border-border text-muted"}`}>{label}</button>
          ))}
        </div>
      </div>
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[1000px] font-mono text-[11px]">
          <thead>
            <tr className="text-left text-muted">
              {["Фильтр", "Сделок", "В плюс", "Стопы", "Ср. %", "Сумма %", "PF", "Просадка", "1-я пол.", "2-я пол.", "Устойч."].map((h) => <th key={h} className="px-2 py-2 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const s = f.stats[m];
              if (!s) return null;
              const head = i === 0 || rows[i - 1]!.side !== f.side;
              return (
                <tr key={f.id} className={`border-t ${head ? "border-foreground/40" : "border-border"} ${f.id === "long_today" || f.id === "short_any" ? "bg-card-hi" : ""}`}>
                  <td className="px-2 py-1.5 font-sans text-xs">{f.label}</td>
                  <td className="px-2">{s.n}{s.open ? <span className="text-muted"> +{s.open} откр.</span> : null}</td>
                  <td className="px-2">{pct(s.winPct)}</td>
                  <td className="px-2">{pct(s.stopPct)}</td>
                  <td className={`px-2 ${tone(s.avg)}`}>{sg(s.avg)}</td>
                  <td className={`px-2 font-bold ${tone(s.sum)}`}>{sg(s.sum, 0)}</td>
                  <td className="px-2">{s.pf === null ? "—" : s.pf.toFixed(2).replace(".", ",")}</td>
                  <td className="px-2 text-down">{s.maxDd ? `−${s.maxDd.toFixed(0)}` : "0"}</td>
                  <td className={`px-2 ${tone(s.half1.avg)}`}>{sg(s.half1.avg)} <span className="text-muted">({s.half1.n})</span></td>
                  <td className={`px-2 ${tone(s.half2.avg)}`}>{sg(s.half2.avg)} <span className="text-muted">({s.half2.n})</span></td>
                  <td className="px-2">{s.n ? (stable(s) ? <span className="text-up">да</span> : <span className="text-down">нет</span>) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Dist({ title, data, n }: { title: string; data: Array<[string, number]>; n: number }) {
  return (
    <div>
      <p className="mb-1 font-sans text-xs font-semibold">{title}</p>
      {data.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <span className="w-24 shrink-0">{k}</span>
          <span className="h-2 bg-primary" style={{ width: `${n ? Math.max(1, (v / n) * 200) : 0}px` }} />
          <span className="text-muted">{v} ({n ? Math.round((v / n) * 100) : 0}%)</span>
        </div>
      ))}
    </div>
  );
}

/** Plain text of the whole report (no HTML), to paste into a chat. */
function reportText(r: Report): string {
  const out: string[] = [`Нигилист — стратегии торговли, расчёт ${dt(r.finishedAt)}`];
  if (r.parity) out.push(`Проверка: ${r.parity.checked - r.parity.mismatched} из ${r.parity.checked} живых сделок совпали по причине закрытия`);
  for (const ds of r.datasets) {
    out.push("", `=== ${DS_LABEL[ds.name]}: ${d(ds.from)} — ${d(ds.to)}, сделок ${ds.trades}, монет ${ds.symbols}`);
    for (const g of Object.keys(GROUP_LABEL) as Group[]) {
      out.push("", `--- ${GROUP_LABEL[g]}`, "id | n (откр.) | плюс% | стоп% | ≈0% | ср.% | сумма% | PF | просадка | серия | 1-я пол. ср.(n) | 2-я пол. ср.(n) | ср. время ч | %/день | распределение");
      for (const { id, stats: s } of [...ds.groups[g]].sort((a, b) => b.stats.sum - a.stats.sum)) {
        out.push([id, `${s.n} (${s.open})`, pct(s.winPct), pct(s.stopPct), pct(s.flatPct), sg(s.avg), sg(s.sum, 0), s.pf ?? "—", `−${s.maxDd.toFixed(0)}`, s.worstStreak,
          `${sg(s.half1.avg)} (${s.half1.n})`, `${sg(s.half2.avg)} (${s.half2.n})`, s.avgHoldH.toFixed(0), sg(s.perDay),
          s.buckets.map(([k, v]) => `${k}:${v}`).join(" ")].join(" | "));
      }
    }
    if (ds.filters) {
      out.push("", `--- Проверка новых фильтров входа (${DS_LABEL[ds.name]})`, "фильтр | ведение | n (откр.) | плюс% | стоп% | ср.% | сумма% | PF | просадка | 1-я пол. ср.(n) | 2-я пол. ср.(n)");
      for (const f of ds.filters) for (const [id, label] of TRADED) {
        const s = f.stats[id];
        if (!s) continue;
        out.push([f.label, label, `${s.n} (${s.open})`, pct(s.winPct), pct(s.stopPct), sg(s.avg), sg(s.sum, 0), s.pf ?? "—", `−${s.maxDd.toFixed(0)}`,
          `${sg(s.half1.avg)} (${s.half1.n})`, `${sg(s.half2.avg)} (${s.half2.n})`].join(" | "));
      }
    }
  }
  return out.join("\n");
}
