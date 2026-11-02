/** Pure part of the rejection follow-up (see rejections.ts): no database. */
import { INTERVAL_MS, type Candle } from "./candles";

const SPAN = INTERVAL_MS["30m"];

export const REJECTION_TARGET_PCT = 10;

export type RejectionFirst = "plus10" | "stop" | "none";
export type RejectionState = {
  side: "long" | "short"; entry: number; stop: number | null; signalAt: number; windowEnd: number;
  first: RejectionFirst | null; firstAt: number | null; sameCandle: boolean;
  peakPct: number; lowPct: number; lastCandleT: number | null;
};

/** Pure step: applies closed 30m candles (after the entry) to the state. */
export function followRejection(st: RejectionState, candles: Candle[], now: number): { state: RejectionState; done: boolean } {
  const s = { ...st };
  const dir = s.side === "long" ? 1 : -1;
  const pct = (p: number) => ((p - s.entry) / s.entry) * 100 * dir;
  for (const c of candles) {
    if (c.t < s.signalAt) continue;                 // starts before the entry
    if (s.lastCandleT !== null && c.t <= s.lastCandleT) continue;
    if (c.t + SPAN > now) break;                    // not closed
    if (c.t >= s.windowEnd) break;
    s.lastCandleT = c.t;
    const best = pct(dir === 1 ? c.h : c.l);
    const worst = pct(dir === 1 ? c.l : c.h);
    s.peakPct = Math.max(s.peakPct, best);
    s.lowPct = Math.min(s.lowPct, worst);
    if (s.first === null) {
      const stopHit = s.stop !== null && (dir === 1 ? c.l <= s.stop : c.h >= s.stop);
      const plusHit = best >= REJECTION_TARGET_PCT;
      if (stopHit) { s.first = "stop"; s.firstAt = c.t + SPAN; s.sameCandle = plusHit; }
      else if (plusHit) { s.first = "plus10"; s.firstAt = c.t + SPAN; }
    }
  }
  // The window is over once its last candle has closed (a coin without candles ends with what it had).
  const windowOver = now >= s.windowEnd + SPAN;
  if (windowOver && s.first === null) s.first = "none";
  return { state: s, done: windowOver };
}

export type DecisionRow = { id: number; symbol: string; setup: string; bar_time: string; reason: string | null; details: Record<string, unknown> };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Entry and stop of a rejection: from its details, else the close of the signal bar and the stop % recorded. */
export function rejectionLevels(d: DecisionRow, ltfCandles: Candle[]): { entry: number | null; stop: number | null } {
  const side = d.setup.endsWith("_short") ? "short" : "long";
  const det = d.details ?? {};
  let entry = num(det.entry);
  if (entry === null) entry = ltfCandles.find((c) => c.t === Number(d.bar_time))?.c ?? null;
  let stop = num(det.stop);
  const riskPct = num(det.riskPct);
  if (stop === null && entry !== null && riskPct !== null) stop = entry * (1 - (side === "long" ? 1 : -1) * riskPct / 100);
  // A stop on the wrong side of the entry cannot be followed.
  if (stop !== null && entry !== null && (side === "long" ? stop >= entry : stop <= entry)) stop = null;
  return { entry, stop };
}

