import { useState } from "react";
import { Empty, Kpi, Panel, Segmented, SideTag, Table } from "../components/ui";
import {
  REASON_LABEL, STAGE_LABEL, coin, dur, num, price, setupLabel, usePoll, when,
  type Candidate, type Decision, type ScannerData,
} from "../lib/api";

const NEXT_SCAN_DELAY_MS = 20_000;
const BAR = 30 * 60_000;

function ScanState({ data }: { data: ScannerData | null }) {
  const last = data?.cycles[0] ?? null;
  const next = Math.floor(Date.now() / BAR) * BAR + BAR + NEXT_SCAN_DELAY_MS;
  const cur = data?.current ?? null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Kpi label="Скан сейчас" value={cur ? STAGE_LABEL[cur.stage] : "ожидание"} toneClass={cur ? "text-up" : ""}
        hint={cur ? `${cur.done}/${cur.total} монет · идёт ${dur(Date.now() - cur.startedAt)}` : `следующий в ${when(next)}`} />
      <Kpi label="Последний скан" value={last ? when(last.finishedAt) : "—"} hint={last ? `длился ${dur(last.ms)}` : "ещё не было"} />
      <Kpi label="Проверено монет" value={last ? last.checked - last.refreshFailed : "—"}
        hint={last ? (last.refreshFailed ? `без свечей: ${last.refreshFailed}` : "все со свечами") : undefined} />
      <Kpi label="Кандидаты" value={data ? data.candidates.length : "—"} hint="цена в ордер-блоке, ждём слом" />
    </div>
  );
}

function Candidates({ rows }: { rows: Candidate[] }) {
  if (!rows.length) return <Empty>Сейчас ни одна монета не реагирует от ордер-блока.</Empty>;
  return (
    <Table head={["Монета", "", "Сетап", "Ордер-блок", "Цена", "До блока", "Касание", "Свечей назад"]} minWidth={860}>
      {rows.map((c) => {
        const inside = c.lastClose <= c.blockTop && c.lastClose >= c.blockBottom;
        const edge = c.side === "long" ? c.blockTop : c.blockBottom;
        const away = ((c.lastClose - edge) / edge) * 100 * (c.side === "long" ? 1 : -1);
        return (
          <tr key={`${c.symbol}:${c.setup}:${c.blockId}`} className="border-t border-border">
            <td className="py-2 pr-3 font-sans font-semibold">{coin(c.symbol)}</td>
            <td className="pr-3"><SideTag side={c.side} /></td>
            <td className="pr-3 font-sans text-muted">{setupLabel(c.setup)}</td>
            <td className="pr-3">{price(c.blockBottom)} – {price(c.blockTop)} <span className="text-muted">{c.blockScope === "swing" ? "swing" : "int"}</span></td>
            <td className="pr-3">{price(c.lastClose)}</td>
            <td className={`pr-3 ${inside ? "text-up" : "text-muted"}`}>{inside ? "внутри" : `${away > 0 ? "+" : ""}${away.toFixed(1)}%`}</td>
            <td className="pr-3 text-muted">{when(c.lastTouchAt)}</td>
            <td>{c.barsSinceTouch}</td>
          </tr>
        );
      })}
    </Table>
  );
}

export default function Scanner() {
  const [filter, setFilter] = useState<"" | "accepted" | "rejected">("");
  const { data } = usePoll<{ decisions: Decision[]; reasons7d: Array<{ reason: string; n: number }> }>(
    `/nh/decisions?limit=200${filter ? `&decision=${filter}` : ""}`, 30_000,
  );
  const rows = data?.decisions ?? [];
  const reasons = data?.reasons7d ?? [];
  const total = reasons.reduce((a, r) => a + r.n, 0);
  const { data: scan } = usePoll<ScannerData>("/nh/scanner", 10_000);
  const [side, setSide] = useState<"" | "long" | "short">("");
  const candidates = (scan?.candidates ?? []).filter((c) => !side || c.side === side);
  return (
    <div className="space-y-4 md:space-y-6">
      <ScanState data={scan ?? null} />
      <Panel title={`Кандидаты · ${candidates.length}`} right={<Segmented value={side} onChange={(value) => setSide(value as typeof side)} options={[{ id: "", label: "все" }, { id: "long", label: "лонг" }, { id: "short", label: "шорт" }]} />}>
        <p className="mb-3 text-xs text-muted">Цена коснулась ордер-блока старшего ТФ за последние 12 свечей младшего ТФ, блок не пробит. Сигнал будет, если на младшем ТФ сломается структура.</p>
        {scan ? <Candidates rows={candidates} /> : <Empty>Загрузка…</Empty>}
      </Panel>
      <Panel title="Циклы сканирования">
        {!scan?.cycles.length ? <Empty>{scan ? "Первый цикл ещё не завершён." : "Загрузка…"}</Empty> : (
          <Table head={["Свеча", "Закончен", "Длительность", "Монет", "Без свечей", "Повтор поздних", "Кандидатов", "Решений", "Сигналов"]} minWidth={860}>
            {scan.cycles.map((c) => (
              <tr key={c.bar} className="border-t border-border">
                <td className="py-2 pr-3">{when(c.bar)}</td>
                <td className="pr-3 text-muted">{when(c.finishedAt)}</td>
                <td className="pr-3">{dur(c.ms)}</td>
                <td className="pr-3">{c.checked}</td>
                <td className={`pr-3 ${c.refreshFailed ? "text-warn" : "text-muted"}`}>{c.refreshFailed}</td>
                <td className="pr-3 text-muted">{c.lateRetries}</td>
                <td className="pr-3">{c.candidates}</td>
                <td className="pr-3">{c.decisions}</td>
                <td className={c.signals ? "text-up" : "text-muted"}>{c.signals}{c.error ? <span className="ml-2 text-down" title={c.error}>ошибка</span> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <p className="text-sm text-muted">Решения: каждый слом структуры младшего ТФ внутри ордер-блока старшего ТФ: сигнал или причина отказа. Проверка — через ~20 с после закрытия каждой 30-минутной свечи.</p>
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
      <Panel title="Последние решения" right={<Segmented value={filter} onChange={(value) => setFilter(value as typeof filter)} options={[{ id: "", label: "все" }, { id: "accepted", label: "сигналы" }, { id: "rejected", label: "отказы" }]} />}>
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
