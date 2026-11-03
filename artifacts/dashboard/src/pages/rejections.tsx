/**
 * «Отклонённые сигналы» (owner 2026-11-03): every setup Nihilist did not send — the reason,
 * and what the price did next (+10% before the stop or not); skips (coin already in a trade,
 * the same entry by another setup) apart. Moved here from «Сканер», where it was out of sight.
 */
import { useState } from "react";
import { Empty, Panel, Segmented, SideTag, Table } from "../components/ui";
import { coin, num, price, reasonLabel, setupLabel, signed, usePoll, when, type Decision } from "../lib/api";

type OutcomeSummary = {
  reason: string; side: "long" | "short"; n: number; no_data: number; plus10: number; stop: number; stop_same_candle: number;
  neither: number; waiting: number; peak_lt5: number; peak_5_10: number; peak_10_15: number; peak_15_20: number; peak_20: number;
};
type OutcomeRow = {
  decision_id: number; symbol: string; setup: string; side: "long" | "short"; reason: string; signal_at: string;
  entry: number | null; stop: number | null; status: string; first_event: string | null; first_at: string | null;
  same_candle: boolean; peak_pct: number; low_pct: number;
};
const FIRST_LABEL: Record<string, string> = { plus10: "+10% раньше стопа", stop: "стоп раньше", none: "ни то ни другое" };

/** What rejected setups did next — +10% before the stop or not (owner 2026-11-02). */
function RejectionOutcomes() {
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState("");
  const { data } = usePoll<{ summary: OutcomeSummary[]; rows: OutcomeRow[] }>(`/nh/rejections?days=${days}`, 60_000);
  const summary = data?.summary ?? [];
  const rows = (data?.rows ?? []).filter((r) => !reason || r.reason === reason);
  const pct = (a: number, b: number) => (b ? ` (${Math.round((a / b) * 100)}%)` : "");
  return (
    <Panel title="Причины отказов и что было дальше" right={<Segmented value={days} onChange={(v) => setDays(v as number)} options={[{ id: 7, label: "7 дн" }, { id: 30, label: "30 дн" }, { id: 90, label: "90 дн" }]} />}>
      <p className="mb-3 text-xs text-muted">
        От входа, который был бы у отклонённого сетапа, по закрытым 30m свечам в окне удержания блока (4h — 7 дней, 1D — 21 день): что раньше — +10% по ходу сделки или стоп.
        Если в одной свече и то и другое — считается стоп (осторожно в пользу отказа). «Ещё в окне» — пока ни того, ни другого, окно не закончилось. Пики — максимум по ходу за окно (или до текущего момента).
      </p>
      {!summary.length ? <Empty>{data ? "Пока нет отказов с данными." : "Загрузка…"}</Empty> : (
        <Table head={["Причина", "Сторона", "Отказов", "+10% раньше стопа", "Стоп раньше", "Ни то ни другое", "Ещё в окне", "Пик <5 / 5–10 / 10–15 / 15–20 / 20+", "Нет данных"]} minWidth={1100}>
          {summary.map((r) => {
            const known = r.n - r.no_data;
            return (
              <tr key={`${r.reason}:${r.side}`} onClick={() => setReason(reason === r.reason ? "" : r.reason)}
                className={`cursor-pointer border-t border-border ${reason === r.reason ? "bg-white/[0.04]" : "hover:bg-white/[0.02]"}`}>
                <td className="py-2 pr-3 font-sans">{reasonLabel(r.reason)}</td>
                <td className="pr-3"><SideTag side={r.side} /></td>
                <td className="pr-3">{r.n}</td>
                <td className="pr-3 text-up">{r.plus10}{pct(r.plus10, known)}</td>
                <td className="pr-3 text-down">{r.stop}{pct(r.stop, known)}{r.stop_same_candle ? <span className="text-muted"> · в одной свече {r.stop_same_candle}</span> : null}</td>
                <td className="pr-3 text-muted">{r.neither}</td>
                <td className="pr-3 text-muted">{r.waiting}</td>
                <td className="pr-3 font-mono text-xs">{r.peak_lt5} / {r.peak_5_10} / {r.peak_10_15} / {r.peak_15_20} / {r.peak_20}</td>
                <td className="text-muted">{r.no_data}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {rows.length > 0 && (
        <div className="mt-5">
          <p className="label mb-2">Отклонённые сигналы{reason ? ` · ${reasonLabel(reason)}` : ""} · клик по причине выше — только она</p>
          <Table head={["Сигнал был бы", "Монета", "Сетап", "Причина", "Вход", "Стоп", "Итог", "Когда", "Пик", "Худшее"]} minWidth={1100}>
            {rows.slice(0, 150).map((r) => (
              <tr key={r.decision_id} className="border-t border-border">
                <td className="py-2 pr-3 text-muted">{when(r.signal_at)}</td>
                <td className="pr-3 font-sans font-semibold">{coin(r.symbol)}</td>
                <td className="pr-3 font-sans text-muted">{setupLabel(r.setup)}</td>
                <td className="pr-3 font-sans text-foreground/80">{reasonLabel(r.reason)}</td>
                <td className="pr-3">{price(r.entry)}</td>
                <td className="pr-3">{r.stop === null ? "—" : price(r.stop)}</td>
                <td className={`pr-3 font-sans ${r.first_event === "plus10" ? "text-up" : r.first_event === "stop" ? "text-down" : "text-muted"}`}>
                  {r.status === "no_data" ? "нет данных" : r.first_event ? FIRST_LABEL[r.first_event] : "ещё в окне"}{r.same_candle ? " (в одной свече)" : ""}
                </td>
                <td className="pr-3 text-muted">{r.first_at ? when(r.first_at) : "—"}</td>
                <td className="pr-3 text-up">{signed(r.peak_pct, 1, "%")}</td>
                <td className="text-down">{signed(r.low_pct, 1, "%")}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Panel>
  );
}

/** All decisions of the last 7 days: how many became signals and why the rest did not. */
function Totals() {
  const { data } = usePoll<{ decisions: Decision[]; reasons7d: Array<{ reason: string; n: number }> }>("/nh/decisions?limit=1", 60_000);
  const reasons = data?.reasons7d ?? [];
  const total = reasons.reduce((a, r) => a + r.n, 0);
  return (
    <Panel title={`Все решения за 7 дней · ${total}`}>
      <p className="mb-3 text-xs text-muted">Каждый слом структуры младшего ТФ внутри ордер-блока старшего ТФ — либо сигнал, либо причина, почему его нет.</p>
      {!reasons.length ? <Empty>{data ? "Пока решений нет." : "Загрузка…"}</Empty> : (
        <div className="space-y-2">
          {reasons.map((r) => (
            <div key={r.reason}>
              <div className="flex justify-between text-sm"><span>{reasonLabel(r.reason)}</span><span className="font-mono text-muted">{r.n} · {Math.round((r.n / total) * 100)}%</span></div>
              <div className="mt-1 h-1 bg-border"><div className={`h-full ${r.reason === "accepted" ? "bg-up" : "bg-primary/70"}`} style={{ width: `${(r.n / total) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Skips: not a bad setup — the coin is already in a trade, or the same entry came by another setup. */
function Skips() {
  const { data } = usePoll<{ decisions: Decision[] }>("/nh/decisions?limit=100&decision=skipped", 60_000);
  const rows = data?.decisions ?? [];
  return (
    <Panel title="Пропуски">
      <p className="mb-3 text-xs text-muted">Сетап хороший, но сигнал не выдан: по монете уже открыта сделка в эту сторону, или тот же вход пришёл другим сетапом.</p>
      {!rows.length ? <Empty>{data ? "Пропусков нет." : "Загрузка…"}</Empty> : (
        <Table head={["Время", "Монета", "", "Сетап", "Причина", "Вход", "Стоп %"]} minWidth={820}>
          {rows.map((d) => {
            const det = d.details as Record<string, number | undefined>;
            return (
              <tr key={d.id} className="border-t border-border">
                <td className="py-2 pr-3 text-muted">{when(d.created_at)}</td>
                <td className="pr-3 font-sans font-semibold">{coin(d.symbol)}</td>
                <td className="pr-3"><SideTag side={d.setup.endsWith("_short") ? "short" : "long"} /></td>
                <td className="pr-3 font-sans text-muted">{setupLabel(d.setup)}</td>
                <td className="pr-3 font-sans text-foreground/80">{reasonLabel(d.reason)}</td>
                <td className="pr-3">{det.entry !== undefined ? price(det.entry) : "—"}</td>
                <td>{num(det.riskPct, 1)}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

export default function Rejections() {
  return (
    <div className="space-y-4 md:space-y-6">
      <Totals />
      <RejectionOutcomes />
      <Skips />
    </div>
  );
}
