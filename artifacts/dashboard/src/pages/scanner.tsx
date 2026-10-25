import { useState } from "react";
import { Empty, Panel, Segmented, Table } from "../components/ui";
import { REASON_LABEL, coin, num, setupLabel, usePoll, when, type Decision } from "../lib/api";

export default function Scanner() {
  const [filter, setFilter] = useState<"" | "accepted" | "rejected">("");
  const { data } = usePoll<{ decisions: Decision[]; reasons7d: Array<{ reason: string; n: number }> }>(
    `/nh/decisions?limit=200${filter ? `&decision=${filter}` : ""}`, 30_000,
  );
  const rows = data?.decisions ?? [];
  const reasons = data?.reasons7d ?? [];
  const total = reasons.reduce((a, r) => a + r.n, 0);
  return (
    <div className="space-y-4 md:space-y-6">
      <p className="text-sm text-muted">Каждый слом структуры младшего ТФ внутри ордер-блока старшего ТФ: сигнал или причина отказа. Проверка — через ~20 с после закрытия каждой 30-минутной свечи.</p>
      <Panel title="Итоги за 7 дней">
        {!reasons.length ? <Empty>Пока решений нет.</Empty> : (
          <div className="space-y-2">
            {reasons.map((r) => (
              <div key={r.reason}>
                <div className="flex justify-between text-sm"><span>{REASON_LABEL[r.reason] ?? r.reason}</span><span className="font-mono text-muted">{r.n}</span></div>
                <div className="mt-1 h-1 bg-border"><div className={`h-full ${r.reason === "accepted" ? "bg-up" : "bg-primary/70"}`} style={{ width: `${(r.n / total) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Последние решения" right={<Segmented<"" | "accepted" | "rejected"> value={filter} onChange={setFilter} options={[{ id: "", label: "все" }, { id: "accepted", label: "сигналы" }, { id: "rejected", label: "отказы" }]} />}>
        {!rows.length ? <Empty>{data ? "Пока пусто." : "Загрузка…"}</Empty> : (
          <Table head={["Время", "Монета", "Сетап", "Решение", "Вход", "Стоп %", "R до тейка 1"]} minWidth={820}>
            {rows.map((d) => {
              const det = d.details as Record<string, number | undefined>;
              return (
                <tr key={d.id} className="border-t border-border">
                  <td className="py-2 pr-3 text-muted">{when(d.created_at)}</td>
                  <td className="pr-3 font-sans font-semibold">{coin(d.symbol)}</td>
                  <td className="pr-3 font-sans text-muted">{setupLabel(d.setup)}</td>
                  <td className={`pr-3 font-sans ${d.decision === "accepted" ? "text-up" : "text-foreground/80"}`}>
                    {d.decision === "accepted" ? "сигнал" : REASON_LABEL[d.reason ?? ""] ?? d.reason}
                  </td>
                  <td className="pr-3">{det.entry !== undefined ? num(det.entry, 6) : "—"}</td>
                  <td className="pr-3">{num(det.riskPct, 1)}</td>
                  <td>{num(det.rr1)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}
