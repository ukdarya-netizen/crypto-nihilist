/**
 * Telegram texts in the AltBullet layout (POSITION UPDATE / POSITION CLOSED,
 * ticker and setup hashtags). Plain text only: no HTML, no Markdown.
 */
import { BREAKEVEN_AT_PCT } from "../engine/config";

export type SignalForText = {
  symbol: string; setup: string; htf: string; ltf: string; side: "long" | "short";
  entry: number; stop: number; tp1: number; block_top: number; block_bottom: number; block_scope: string;
  opened_at: Date | string; targets_source: string;
};
export type EventForText = { kind: string; price: number | null; detail: Record<string, unknown>; created_at: Date | string };

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return p.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return Number(p.toPrecision(4)).toString();
}
export const fmtPct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;

const coin = (s: string) => s.replace(/-USDT$/, "");
const tag = (s: SignalForText) => `#${coin(s.symbol).replace(/[^A-Za-z0-9]/g, "")} #nh_${s.setup}`;
const sideRu = (side: string) => (side === "long" ? "ЛОНГ" : "ШОРТ");
const tf = (v: string) => (v === "1d" ? "1D" : v);
const dir = (s: SignalForText) => (s.side === "long" ? 1 : -1);
const pctFrom = (s: SignalForText, price: number) => ((price - s.entry) / s.entry) * 100 * dir(s);

export function duration(from: Date | string, to: Date | string): string {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  return d ? `${d}д ${h % 24}ч` : h ? `${h}ч` : `${Math.max(1, Math.round(ms / 60_000))}м`;
}

function stopLine(s: SignalForText, stop: number, trailing: boolean): string {
  const p = pctFrom(s, stop);
  const label = trailing ? "Трейлинг-стоп" : Math.abs(p) < 1e-9 ? "Стоп в безубытке" : "Стоп";
  return `🛡 ${label}: ${fmtP(stop)} (${fmtPct(p)} от входа)`;
}

export function formatEvent(s: SignalForText, e: EventForText): string {
  const sym = `${coin(s.symbol)} ${sideRu(s.side)}`;
  const d = e.detail;
  const price = e.price ?? s.entry;
  const priceLine = `${fmtP(s.entry)} → ${fmtP(price)} (${fmtPct(pctFrom(s, price))}) | ${duration(s.opened_at, e.created_at)}`;
  const currentStop = Number(d.currentStop ?? s.stop);
  const trailing = Boolean(d.kind === "trailing_on" || (Number(d.peakPct ?? 0) >= 15));

  if (e.kind === "opened") {
    const stopPct = pctFrom(s, s.stop);
    const tp1Pct = pctFrom(s, s.tp1);
    return [
      `🟣 NIHILYST · ${sym}`,
      `Ордер-блок ${tf(s.htf)} → слом структуры ${tf(s.ltf)}`,
      ``,
      `Вход: ${fmtP(s.entry)}`,
      `Стоп: ${fmtP(s.stop)} (${fmtPct(stopPct)})`,
      `Тейк 1: ${fmtP(s.tp1)} (${fmtPct(tp1Pct)}) — фиксируем 50%, стоп в безубыток`,
      BREAKEVEN_AT_PCT !== null ? `Безубыток: на +${BREAKEVEN_AT_PCT}% стоп переносится на вход` : null,
      `Трейлинг: с +15%, стоп на 10 п.п. ниже пика`,
      ``,
      `Ордер-блок: ${fmtP(s.block_bottom)} – ${fmtP(s.block_top)}`,
      s.targets_source === "r_multiple" ? `Выше нет непробитых уровней ${tf(s.htf)}: тейк 1 = 2R` : null,
      ``,
      tag(s),
    ].filter((line) => line !== null).join("\n");
  }
  if (e.kind === "closed") {
    const reason = String(d.reason);
    const title = reason === "trailing" ? "🟢 PROFIT (трейлинг)"
      : reason === "breakeven" ? (d.tp1Hit ? "🔵 БЕЗУБЫТОК после тейка 1" : "🔵 БЕЗУБЫТОК")
        : reason === "timeout" ? "⏱ Закрыто по времени удержания"
          : "🔴 STOP LOSS";
    const total = Number(d.pnlPct);
    return [
      `🏁 POSITION CLOSED — ${sym}`,
      title,
      priceLine,
      ``,
      `📈 Пик позиции: ${fmtPct(Number(d.peakPct ?? 0))}`,
      d.tp1Hit ? `🎯 Тейк 1 был взят: ${fmtP(s.tp1)} (${fmtPct(pctFrom(s, s.tp1))}, 50%)` : null,
      Number.isFinite(total) ? `Итог сделки: ${fmtPct(total)} цены с комиссиями · ${Number(d.r).toFixed(2)}R` : null,
      ``,
      tag(s),
    ].filter((line) => line !== null).join("\n");
  }
  const head = `📊 POSITION UPDATE — ${sym}`;
  if (e.kind === "milestone") {
    return [
      head,
      `🚀 ${fmtPct(Number(d.milestone))}`,
      Boolean(d.trailingActivated) ? `📈 Трейлинг активирован с +15%: стоп на 10 п.п. ниже пика` : null,
      priceLine,
      ``,
      stopLine(s, currentStop, trailing),
      ``,
      tag(s),
    ].filter((line) => line !== null).join("\n");
  }
  if (e.kind === "tp1") {
    return [head, `🎯 ТЕЙК 1 ${fmtPct(pctFrom(s, s.tp1))}`, priceLine, ``, `✂️ Фиксируем 50%`, stopLine(s, currentStop, trailing), `⏳ Дальше: трейлинг с +15%`, ``, tag(s)].join("\n");
  }
  if (e.kind === "breakeven") {
    return [head, `🛡 Стоп в безубыток`, priceLine, ``, stopLine(s, currentStop, false), ``, tag(s)].join("\n");
  }
  if (e.kind === "trailing_on") {
    return [head, `📈 ТРЕЙЛИНГ +15%`, priceLine, ``, stopLine(s, Number(d.trailingStop ?? currentStop), true), `Стоп держится на 10 п.п. ниже пика и подтягивается за ценой`, ``, tag(s)].join("\n");
  }
  return [head, priceLine, ``, tag(s)].join("\n");
}
