/**
 * Telegram texts in the AltBullet layout (POSITION UPDATE / POSITION CLOSED,
 * ticker and setup hashtags). Plain text only: no HTML, no Markdown.
 * English only (owner 2026-11-10: the channel and the bot are fully English).
 */
import { BREAKEVEN_AT_PCT, BTC_TARGETS_R, BTC_TARGETS_SOURCE, NO_TP_TARGETS_SOURCE, PARTIAL_AT_PCT, PCT_TARGETS_SOURCE } from "../engine/config";

export type SignalForText = {
  symbol: string; setup: string; htf: string; ltf: string; side: "long" | "short";
  entry: number; stop: number; tp1: number; tp2?: number | null; block_top: number; block_bottom: number; block_scope: string;
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
const sideEn = (side: string) => (side === "long" ? "LONG" : "SHORT");
const tf = (v: string) => (v === "1d" ? "1D" : v);
const dir = (s: SignalForText) => (s.side === "long" ? 1 : -1);
const pctFrom = (s: SignalForText, price: number) => ((price - s.entry) / s.entry) * 100 * dir(s);

export function duration(from: Date | string, to: Date | string): string {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function stopLine(s: SignalForText, stop: number, trailing: boolean): string {
  const p = pctFrom(s, stop);
  const label = trailing ? "Trailing stop" : Math.abs(p) < 1e-9 ? "Stop at break-even" : "Stop";
  return `🛡 ${label}: ${fmtP(stop)} (${fmtPct(p)} from entry)`;
}

export function formatEvent(s: SignalForText, e: EventForText): string {
  const sym = `${coin(s.symbol)} ${sideEn(s.side)}`;
  const d = e.detail;
  const price = e.price ?? s.entry;
  const priceLine = `${fmtP(s.entry)} → ${fmtP(price)} (${fmtPct(pctFrom(s, price))}) | ${duration(s.opened_at, e.created_at)}`;
  const currentStop = Number(d.currentStop ?? s.stop);
  const trailing = Boolean(d.kind === "trailing_on" || (Number(d.peakPct ?? 0) >= 15));

  if (e.kind === "opened") {
    const stopPct = pctFrom(s, s.stop);
    const tp1Pct = pctFrom(s, s.tp1);
    const noTp = s.targets_source === NO_TP_TARGETS_SOURCE;
    const btc = s.targets_source === BTC_TARGETS_SOURCE;
    return [
      `🟣 NIHILYST · ${sym}`,
      `Order block ${tf(s.htf)} → change of character ${tf(s.ltf)}`,
      ``,
      `Entry: ${fmtP(s.entry)}`,
      `Stop: ${fmtP(s.stop)} (${fmtPct(stopPct)})`,
      ...(btc ? [
        // BTC (owner 2026-11-10, as BTC Bullet): targets in R, no +5% / +8% / +15% rules.
        `TP 1: ${fmtP(s.tp1)} (${fmtPct(tp1Pct)}, ${BTC_TARGETS_R[0]}R) — close 50%, stop to break-even`,
        s.tp2 != null ? `TP 2: ${fmtP(Number(s.tp2))} (${fmtPct(pctFrom(s, Number(s.tp2)))}, ${BTC_TARGETS_R[1]}R) — close the rest` : null,
      ] : [
        BREAKEVEN_AT_PCT !== null ? `Break-even: at +${BREAKEVEN_AT_PCT}% the stop moves to entry` : null,
        // Owner 2026-11-10: 50% at +10%, the rest by the trailing stop from +15%.
        s.targets_source === PCT_TARGETS_SOURCE ? `Take: ${fmtP(s.tp1)} (+${PARTIAL_AT_PCT}%) — 50% closed`
          : noTp ? null : `TP 1: ${fmtP(s.tp1)} (${fmtPct(tp1Pct)}) — close 50%, stop to break-even`,
        `Trailing: from +15%, stop 10 pp below the peak`,
      ]),
      ``,
      `Order block: ${fmtP(s.block_bottom)} – ${fmtP(s.block_top)}`,
      s.targets_source === "r_multiple" ? `No unbroken ${tf(s.htf)} levels beyond: TP 1 = 2R` : null,
      ``,
      tag(s),
    ].filter((line) => line !== null).join("\n");
  }
  if (e.kind === "closed") {
    const reason = String(d.reason);
    const title = reason === "trailing" ? "🟢 PROFIT (trailing stop)"
      : reason === "take" ? (s.targets_source === BTC_TARGETS_SOURCE ? `🟢 PROFIT (TP 2 — ${BTC_TARGETS_R[1]}R)` : `🟢 PROFIT (take, whole position closed)`)
      : reason === "breakeven" ? (d.tp1Hit ? "🔵 BREAK-EVEN after TP 1" : "🔵 BREAK-EVEN")
        : reason === "timeout" ? "⏱ Closed by holding time"
          : "🔴 STOP LOSS";
    const total = Number(d.pnlPct);
    return [
      `🏁 POSITION CLOSED — ${sym}`,
      title,
      priceLine,
      ``,
      `📈 Position peak: ${fmtPct(Number(d.peakPct ?? 0))}`,
      d.tp1Hit ? (s.targets_source === PCT_TARGETS_SOURCE ? `🎯 50% was taken at +${PARTIAL_AT_PCT}%: ${fmtP(s.tp1)}` : `🎯 TP 1 was hit: ${fmtP(s.tp1)} (${fmtPct(pctFrom(s, s.tp1))}, 50%)`) : null,
      Number.isFinite(total) ? `Trade result: ${fmtPct(total)} of price after fees · ${Number(d.r).toFixed(2)}R` : null,
      ``,
      tag(s),
    ].filter((line) => line !== null).join("\n");
  }
  const head = `📊 POSITION UPDATE — ${sym}`;
  if (e.kind === "milestone") {
    return [
      head,
      `🚀 ${fmtPct(Number(d.milestone))}`,
      Boolean(d.trailingActivated) ? `📈 Trailing on from +15%: stop 10 pp below the peak` : null,
      priceLine,
      ``,
      stopLine(s, currentStop, trailing),
      ``,
      tag(s),
    ].filter((line) => line !== null).join("\n");
  }
  if (e.kind === "tp1") {
    return [head, s.targets_source === PCT_TARGETS_SOURCE ? `🎯 TAKE +${PARTIAL_AT_PCT}%` : `🎯 TP 1 ${fmtPct(pctFrom(s, s.tp1))}`, priceLine, ``, `✂️ 50% closed`, stopLine(s, currentStop, trailing), s.targets_source === BTC_TARGETS_SOURCE && s.tp2 != null ? `⏳ Next: TP 2 at ${fmtP(Number(s.tp2))} (${BTC_TARGETS_R[1]}R)` : `⏳ Next: trailing from +15%`, ``, tag(s)].join("\n");
  }
  if (e.kind === "breakeven") {
    return [head, `🛡 Stop to break-even`, priceLine, ``, stopLine(s, currentStop, false), ``, tag(s)].join("\n");
  }
  if (e.kind === "trailing_on") {
    return [head, `📈 TRAILING +15%`, priceLine, ``, stopLine(s, Number(d.trailingStop ?? currentStop), true), `The stop stays 10 pp below the peak and follows the price`, ``, tag(s)].join("\n");
  }
  return [head, priceLine, ``, tag(s)].join("\n");
}
