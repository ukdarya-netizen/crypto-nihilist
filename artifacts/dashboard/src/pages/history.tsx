import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Segmented } from "../components/ui";
import { SignalHistory, type TradeStatus } from "../components/signal-history";
import { isOwner, setupLabel } from "../lib/api";
import { hashParams } from "../components/layout";

/**
 * Owner 2026-11-20: every tile, calendar day and table row opens this page with the exact trades behind its number.
 * Filters come from the link (#/history?…); the chips above the list show them and can be dropped one by one.
 */
const EXTRA_KEYS = ["by", "day", "month", "side", "setup", "peak", "sign", "hold", "id", "today", "snap"] as const;
type Extra = Partial<Record<(typeof EXTRA_KEYS)[number], string>>;

const PEAK_LABEL: Record<string, string> = {
  belt5: "BE STOP, пик до +5%", be5: "BE STOP, пик +5…<8%", be8: "BE STOP, пик +8…<10%", be10: "BE STOP, пик от +10%",
  p5: "пик от +5%", p10: "пик от +10%", p15: "пик от +15%", p30: "пик от +30%",
};
const HOLD_LABEL: Record<string, string> = { lt6h: "в сделке до 6ч", h6_24: "в сделке 6–24ч", d1_3: "в сделке 1–3д", d3_7: "в сделке 3–7д", gt7d: "в сделке больше 7д" };
const SNAP_LABEL: Record<string, string> = { ready: "с метриками", live: "метрики записаны при сигнале", reconstructed: "метрики восстановлены бэкфиллом", unavailable: "метрики не восстановить", pending: "метрики в очереди" };

function chipLabel(key: string, value: string): string {
  switch (key) {
    case "by": return value === "opened" ? "по дню открытия" : "по дню закрытия";
    case "day": return `закрыты ${value} (UTC)`;
    case "month": return `закрыты в ${value} (UTC)`;
    case "side": return value === "long" ? "лонги" : "шорты";
    case "setup": return setupLabel(value);
    case "peak": return PEAK_LABEL[value] ?? value;
    case "sign": return value === "pos" ? "закрыты в плюс" : "закрыты в минус";
    case "hold": return HOLD_LABEL[value] ?? value;
    case "id": return `сделка #${value}`;
    case "today": return "открыты сегодня (UTC)";
    case "snap": return SNAP_LABEL[value] ?? value;
    default: return value;
  }
}

function read() {
  const q = hashParams();
  const extra: Extra = {};
  for (const k of EXTRA_KEYS) { const v = q.get(k); if (v) extra[k] = v; }
  return {
    days: Number(q.get("days")) || 90,
    live: q.get("live") === "1",
    status: (q.get("status") ?? "") as "" | TradeStatus,
    extra,
  };
}

export default function History() {
  const [state, setState] = useState(read);
  useEffect(() => {
    const on = () => setState(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const { days, live, status, extra } = state;
  const set = (patch: Partial<typeof state>) => setState((s) => ({ ...s, ...patch }));
  const drop = (key: string) => set({ extra: Object.fromEntries(Object.entries(extra).filter(([k]) => k !== key)) as Extra });
  const fixedDay = Boolean(extra.day || extra.month || extra.id || extra.today);
  const chips = Object.entries(extra).filter(([k]) => k !== "by" || extra.by === "opened");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(([k, v]) => (
            <button key={k} type="button" onClick={() => drop(k)}
              className="flex items-center gap-1 border border-primary/50 bg-primary/10 px-2 py-1 font-mono text-[11px] text-foreground hover:border-primary">
              {chipLabel(k, v as string)} <X className="size-3" />
            </button>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {isOwner() && <Segmented value={live} onChange={(value) => set({ live: value as boolean })} options={[{ id: false, label: "все сетапы" }, { id: true, label: "только канал" }]} />}
          {!fixedDay && <Segmented value={days} onChange={(value) => set({ days: value as number })} options={[{ id: 7, label: "7 дн" }, { id: 14, label: "14 дн" }, { id: 30, label: "30 дн" }, { id: 90, label: "90 дн" }, { id: 3650, label: "всё" }]} />}
        </div>
      </div>
      <SignalHistory days={days} live={live} status={status} onStatus={(s) => set({ status: s })} extra={extra} limit={5000} title="Все сигналы" />
    </div>
  );
}
