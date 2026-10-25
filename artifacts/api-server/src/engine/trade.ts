/**
 * Virtual trade management, shared by the backtest and the live tracker.
 * 50% closes at TP1, then the stop moves to entry (break-even); 50% at TP2.
 * Within one candle the stop is checked before targets (conservative).
 * Fees: 0.05% taker on entry and on every exit.
 */
import type { Candle } from "./candles";
import type { Side } from "./setups";

export const TAKER_FEE = 0.0005;

export type TradeState = {
  side: Side;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  openedAt: number;
  /** Absolute deadline (ms); position closes at the next candle close after it. */
  expiresAt: number;
  tp1Hit: boolean;
  tp1At: number | null;
  currentStop: number;
  closed: boolean;
  closedAt: number | null;
  closeReason: "stop" | "breakeven" | "tp2" | "timeout" | null;
  exitPrice: number | null;
  /** Best and worst excursion, % of entry in the trade direction. */
  mfePct: number;
  maePct: number;
  /** Last processed candle open time. */
  lastCandleTime: number | null;
};

export function openTrade(input: {
  side: Side; entry: number; stop: number; tp1: number; tp2: number; openedAt: number; maxHoldMs: number;
}): TradeState {
  return {
    side: input.side, entry: input.entry, stop: input.stop, tp1: input.tp1, tp2: input.tp2,
    openedAt: input.openedAt, expiresAt: input.openedAt + input.maxHoldMs,
    tp1Hit: false, tp1At: null, currentStop: input.stop, closed: false, closedAt: null,
    closeReason: null, exitPrice: null, mfePct: 0, maePct: 0, lastCandleTime: null,
  };
}

/** Applies closed candles (any timeframe) that started at/after the trade opened. */
export function applyCandles(state: TradeState, candles: Candle[], spanMs: number): TradeState {
  const s = { ...state };
  const dir = s.side === "long" ? 1 : -1;
  for (const c of candles) {
    if (s.closed) break;
    if (c.t + spanMs <= s.openedAt) continue; // closed before the entry
    if (s.lastCandleTime !== null && c.t <= s.lastCandleTime) continue;
    s.lastCandleTime = c.t;
    const favorable = dir === 1 ? c.h : c.l;
    const adverse = dir === 1 ? c.l : c.h;
    s.mfePct = Math.max(s.mfePct, ((favorable - s.entry) / s.entry) * 100 * dir);
    s.maePct = Math.min(s.maePct, ((adverse - s.entry) / s.entry) * 100 * dir);

    const stopHit = dir === 1 ? c.l <= s.currentStop : c.h >= s.currentStop;
    if (stopHit) {
      s.closed = true;
      s.closedAt = c.t + spanMs;
      s.exitPrice = s.currentStop;
      s.closeReason = s.tp1Hit ? "breakeven" : "stop";
      break;
    }
    const reached = (level: number) => (dir === 1 ? c.h >= level : c.l <= level);
    if (!s.tp1Hit && reached(s.tp1)) {
      s.tp1Hit = true;
      s.tp1At = c.t + spanMs;
      s.currentStop = s.entry;
    }
    if (s.tp1Hit && reached(s.tp2)) {
      s.closed = true;
      s.closedAt = c.t + spanMs;
      s.exitPrice = s.tp2;
      s.closeReason = "tp2";
      break;
    }
    if (c.t + spanMs >= s.expiresAt) {
      s.closed = true;
      s.closedAt = c.t + spanMs;
      s.exitPrice = c.c;
      s.closeReason = "timeout";
      break;
    }
  }
  return s;
}

/** Net result in % of entry price (fees included) and in R. */
export function tradeResult(state: TradeState, markPrice?: number): { pnlPct: number; r: number } {
  const dir = state.side === "long" ? 1 : -1;
  const risk = Math.abs(state.entry - state.stop);
  const leg = (exit: number) => ((exit - state.entry) / state.entry) * 100 * dir;
  const exit = state.closed && state.exitPrice !== null ? state.exitPrice : (markPrice ?? state.entry);
  const gross = state.tp1Hit ? 0.5 * leg(state.tp1) + 0.5 * leg(exit) : leg(exit);
  // Entry on the full size + exits that together cover the full size.
  const fees = 2 * TAKER_FEE * 100;
  const pnlPct = gross - fees;
  const r = risk > 0 ? (pnlPct / 100) * state.entry / risk : 0;
  return { pnlPct: Math.round(pnlPct * 1000) / 1000, r: Math.round(r * 1000) / 1000 };
}
