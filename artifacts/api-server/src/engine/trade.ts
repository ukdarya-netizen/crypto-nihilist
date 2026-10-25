/**
 * Virtual trade management (shared by the backtest and the live tracker),
 * AltBullet-style with a structural first take:
 *   - stop: the structural stop of the setup;
 *   - optional break-even at +BE% (AltBullet's +5%; off unless enabled);
 *   - TP1 (nearest unbroken HTF level): 50% closed, stop to entry;
 *   - trailing from +15% of favourable move: stop = peak − 10 p.p. (never
 *     looser than the stop already in place), for whatever is still open;
 *   - progress alerts at +5, +8, +10, then every +5% (one per jump, highest);
 *   - timeout by the order block's timeframe.
 * Within one candle the stop in force at the candle's start is checked
 * before anything favourable (conservative). Fees: 0.05% taker per side.
 */
import type { Candle } from "./candles";
import type { Side } from "./setups";

export const TAKER_FEE = 0.0005;
export const TRAILING_ACTIVATION_PCT = 15;
export const TRAILING_GAP_PCT = 10;
export const TP1_SHARE = 0.5;

/** +5, +8, +10, then every +5 up to +200, then every +50. */
export function milestones(): number[] {
  const out = [5, 8, 10];
  for (let m = 15; m <= 200; m += 5) out.push(m);
  for (let m = 250; m <= 1000; m += 50) out.push(m);
  return out;
}
const MILESTONES = milestones();

/** Highest milestone above `last` that `pct` has reached (AltBullet nextMilestone). */
export function nextMilestone(last: number, pct: number): number | null {
  let highest: number | null = null;
  for (const m of MILESTONES) if (m > last && pct >= m) highest = m;
  return highest;
}

export type TradeEvent =
  | { kind: "milestone"; at: number; milestone: number; price: number; pct: number }
  | { kind: "breakeven"; at: number; price: number }
  | { kind: "tp1"; at: number; price: number; pct: number }
  | { kind: "trailing_on"; at: number; price: number; trailingStop: number; peakPct: number }
  | { kind: "closed"; at: number; price: number; reason: CloseReason };

export type CloseReason = "stop" | "breakeven" | "trailing" | "timeout";

export type TradeState = {
  side: Side;
  entry: number;
  stop: number;
  tp1: number;
  openedAt: number;
  /** Absolute deadline (ms); position closes at the next candle close after it. */
  expiresAt: number;
  /** Break-even trigger in % (null = only after TP1). */
  breakevenAtPct: number | null;
  breakevenMoved: boolean;
  tp1Hit: boolean;
  tp1At: number | null;
  currentStop: number;
  trailingActive: boolean;
  /** Best favourable move, % of entry. */
  peakPct: number;
  lastMilestone: number;
  closed: boolean;
  closedAt: number | null;
  closeReason: CloseReason | null;
  exitPrice: number | null;
  mfePct: number;
  maePct: number;
  /** Last processed candle open time (per candle span). */
  lastCandleTime: number | null;
};

export function openTrade(input: {
  side: Side; entry: number; stop: number; tp1: number; openedAt: number; maxHoldMs: number;
  breakevenAtPct?: number | null;
}): TradeState {
  return {
    side: input.side, entry: input.entry, stop: input.stop, tp1: input.tp1,
    openedAt: input.openedAt, expiresAt: input.openedAt + input.maxHoldMs,
    breakevenAtPct: input.breakevenAtPct ?? null, breakevenMoved: false,
    tp1Hit: false, tp1At: null, currentStop: input.stop, trailingActive: false,
    peakPct: 0, lastMilestone: 0,
    closed: false, closedAt: null, closeReason: null, exitPrice: null,
    mfePct: 0, maePct: 0, lastCandleTime: null,
  };
}

const priceAtPct = (s: TradeState, pct: number) =>
  s.entry * (1 + (s.side === "long" ? 1 : -1) * pct / 100);
const tighter = (s: TradeState, a: number, b: number) => (s.side === "long" ? Math.max(a, b) : Math.min(a, b));

/** Applies closed candles that started at/after the trade opened. Returns the new state and its events. */
export function applyCandles(state: TradeState, candles: Candle[], spanMs: number): { state: TradeState; events: TradeEvent[] } {
  const s = { ...state };
  const events: TradeEvent[] = [];
  const dir = s.side === "long" ? 1 : -1;
  const pctOf = (price: number) => ((price - s.entry) / s.entry) * 100 * dir;
  for (const c of candles) {
    if (s.closed) break;
    if (c.t + spanMs <= s.openedAt) continue; // closed before the entry
    if (s.lastCandleTime !== null && c.t <= s.lastCandleTime) continue;
    s.lastCandleTime = c.t;
    const at = c.t + spanMs;
    const favorable = dir === 1 ? c.h : c.l;
    const adverse = dir === 1 ? c.l : c.h;
    s.mfePct = Math.max(s.mfePct, pctOf(favorable));
    s.maePct = Math.min(s.maePct, pctOf(adverse));

    // 1. The stop in force at the start of the candle.
    if (dir === 1 ? c.l <= s.currentStop : c.h >= s.currentStop) {
      s.closed = true;
      s.closedAt = at;
      s.exitPrice = s.currentStop;
      s.closeReason = s.trailingActive ? "trailing" : s.tp1Hit || s.breakevenMoved ? "breakeven" : "stop";
      events.push({ kind: "closed", at, price: s.exitPrice, reason: s.closeReason });
      break;
    }
    // 2. Favourable side of the candle.
    const best = pctOf(favorable);
    if (best > s.peakPct) s.peakPct = best;
    const milestone = nextMilestone(s.lastMilestone, best);
    if (milestone !== null) {
      s.lastMilestone = milestone;
      events.push({ kind: "milestone", at, milestone, price: priceAtPct(s, milestone), pct: milestone });
    }
    if (s.breakevenAtPct !== null && !s.breakevenMoved && best >= s.breakevenAtPct) {
      s.breakevenMoved = true;
      s.currentStop = tighter(s, s.currentStop, s.entry);
      events.push({ kind: "breakeven", at, price: priceAtPct(s, s.breakevenAtPct) });
    }
    if (!s.tp1Hit && (dir === 1 ? c.h >= s.tp1 : c.l <= s.tp1)) {
      s.tp1Hit = true;
      s.tp1At = at;
      s.breakevenMoved = true;
      s.currentStop = tighter(s, s.currentStop, s.entry);
      events.push({ kind: "tp1", at, price: s.tp1, pct: pctOf(s.tp1) });
    }
    if (s.peakPct >= TRAILING_ACTIVATION_PCT) {
      const trail = priceAtPct(s, s.peakPct - TRAILING_GAP_PCT);
      const next = tighter(s, s.currentStop, trail);
      if (!s.trailingActive) {
        s.trailingActive = true;
        events.push({ kind: "trailing_on", at, price: priceAtPct(s, TRAILING_ACTIVATION_PCT), trailingStop: next, peakPct: s.peakPct });
      }
      s.currentStop = next;
    }
    // 3. Holding time.
    if (at >= s.expiresAt) {
      s.closed = true;
      s.closedAt = at;
      s.exitPrice = c.c;
      s.closeReason = "timeout";
      events.push({ kind: "closed", at, price: c.c, reason: "timeout" });
      break;
    }
  }
  return { state: s, events };
}

/** Net result in % of entry price (fees included) and in R; open trades at `markPrice`. */
export function tradeResult(state: TradeState, markPrice?: number): { pnlPct: number; r: number } {
  const dir = state.side === "long" ? 1 : -1;
  const risk = Math.abs(state.entry - state.stop);
  const leg = (exit: number) => ((exit - state.entry) / state.entry) * 100 * dir;
  const exit = state.closed && state.exitPrice !== null ? state.exitPrice : (markPrice ?? state.entry);
  const gross = state.tp1Hit ? TP1_SHARE * leg(state.tp1) + (1 - TP1_SHARE) * leg(exit) : leg(exit);
  const fees = 2 * TAKER_FEE * 100;
  const pnlPct = gross - fees;
  const r = risk > 0 ? (pnlPct / 100) * state.entry / risk : 0;
  return { pnlPct: Math.round(pnlPct * 1000) / 1000, r: Math.round(r * 1000) / 1000 };
}
