import { useState } from "react";
import { Empty, Panel, SideTag, Table } from "../components/ui";
import { CLOSE_LABEL, SETUPS, coin, price, setupLabel, signed, tone, usePoll, when, type Signal } from "../lib/api";

export default function History() {
  const [setup, setSetup] = useState("");
  const { data } = usePoll<{ signals: Signal[] }>(`/nh/signals?status=closed&limit=300${setup ? `&setup=${setup}` : ""}`, 30_000);
  const rows = data?.signals ?? [];
  return (
    <Panel title="Закрытые сделки" right={
      <select value={setup} onChange={(e) => setSetup(e.target.value)} className="h-9 border border-border bg-background px-2 text-sm">
        <option value="">Все сетапы</option>
        {SETUPS.map((s) => <option key={s} value={s}>{setupLabel(s)}</option>)}
      </select>}>
      {!rows.length ? <Empty>{data ? "Ещё ничего не закрылось." : "Загрузка…"}</Empty> : (
        <Table head={["Монета", "Сетап", "Открыта", "Закрыта", "Вход", "Стоп", "Тейк 1", "Выход", "Итог", "%", "R", "Пик / просадка"]} minWidth={1100}>
          {rows.map((s) => (
            <tr key={s.id} className="border-t border-border">
              <td className="py-2.5 pr-3 font-sans font-semibold"><span className="flex items-center gap-2">{coin(s.symbol)} <SideTag side={s.side} />{!s.live && <span className="font-mono text-[10px] font-normal text-muted">тень</span>}</span></td>
              <td className="pr-3 font-sans text-muted">{setupLabel(s.setup)}</td>
              <td className="pr-3 text-muted">{when(s.opened_at)}</td>
              <td className="pr-3 text-muted">{when(s.closed_at)}</td>
              <td className="pr-3">{price(s.entry)}</td>
              <td className="pr-3">{price(s.stop)}</td>
              <td className="pr-3">{price(s.tp1)}{s.tp1_hit ? " ✓" : ""}</td>
              <td className="pr-3">{price(s.exit_price)}</td>
              <td className="pr-3 font-sans">{CLOSE_LABEL[s.close_reason ?? ""] ?? s.close_reason}</td>
              <td className={`pr-3 ${tone(s.pnl_pct)}`}>{signed(s.pnl_pct)}</td>
              <td className={`pr-3 ${tone(s.r_multiple)}`}>{signed(s.r_multiple)}</td>
              <td className="text-muted">{signed(s.mfe_pct, 1)} / {signed(s.mae_pct, 1)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}
