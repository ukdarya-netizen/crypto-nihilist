/**
 * Open virtual trades are followed on closed 5-minute BingX candles from
 * CoinGlass (one request per symbol with open trades, every 5 minutes).
 * Every lifecycle step becomes an `nh_signal_events` row: milestone,
 * break-even, TP1, trailing on, closed. Telegram reads that queue.
 * No candles for a symbol = the trade simply waits (it is never closed on a guess).
 */
import { pool } from "@workspace/db";
import { INTERVAL_MS } from "./candles";
import { BREAKEVEN_AT_PCT, TRACK_INTERVAL } from "./config";
import type { HtfInterval } from "./setups";
import { applyCandles, tradeResult, type TradeEvent, type TradeState } from "./trade";
import { getCandles } from "../market/coinglass";
import { logger } from "../lib/logger";

const SPAN = INTERVAL_MS[TRACK_INTERVAL];

export type OpenRow = {
  id: number; symbol: string; setup: string; htf: HtfInterval; side: "long" | "short";
  entry: number; stop: number; tp1: number; current_stop: number | null;
  opened_at: Date; expires_at: Date; tp1_hit: boolean; tp1_at: Date | null;
  breakeven_moved: boolean; trailing_active: boolean; peak_pct: number; last_milestone: number;
  mfe_pct: number; mae_pct: number; last_candle_time: string | null;
};

export function stateFromRow(row: OpenRow): TradeState {
  return {
    side: row.side, entry: row.entry, stop: row.stop, tp1: row.tp1,
    openedAt: row.opened_at.getTime(), expiresAt: row.expires_at.getTime(),
    breakevenAtPct: BREAKEVEN_AT_PCT, breakevenMoved: row.breakeven_moved,
    tp1Hit: row.tp1_hit, tp1At: row.tp1_at ? row.tp1_at.getTime() : null,
    currentStop: row.current_stop ?? row.stop, trailingActive: row.trailing_active,
    peakPct: row.peak_pct, lastMilestone: row.last_milestone,
    closed: false, closedAt: null, closeReason: null, exitPrice: null,
    mfePct: row.mfe_pct, maePct: row.mae_pct,
    lastCandleTime: row.last_candle_time === null ? null : Number(row.last_candle_time),
  };
}

export function eventKey(signalId: number, e: TradeEvent): string {
  switch (e.kind) {
    case "milestone": return `${signalId}:m${e.milestone}`;
    case "breakeven": return `${signalId}:be`;
    case "tp1": return `${signalId}:tp1`;
    case "trailing_on": return `${signalId}:trail`;
    case "closed": return `${signalId}:closed`;
  }
}

export async function insertEvent(
  signalId: number, key: string, kind: string, price: number | null, detail: Record<string, unknown>, at: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO nh_signal_events (signal_id, event_key, kind, price, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_key) DO NOTHING`,
    [signalId, key, kind, price, JSON.stringify(detail), new Date(at)],
  );
}

async function trackRow(row: OpenRow, now: number): Promise<void> {
  const before = stateFromRow(row);
  const from = before.lastCandleTime ?? before.openedAt - SPAN;
  const limit = Math.min(1000, Math.max(3, Math.ceil((now - from) / SPAN) + 2));
  const candles = await getCandles(row.symbol, TRACK_INTERVAL, limit);
  if (candles === null) return; // no data: wait for the next pass
  const closed = candles.filter((c) => c.t + SPAN <= now);
  const { state: after, events } = applyCandles(before, closed, SPAN);
  if (after.lastCandleTime === before.lastCandleTime) return;
  const mark = closed.length ? closed[closed.length - 1].c : undefined;
  const result = tradeResult(after, mark);
  await pool.query(
    `UPDATE nh_signals SET status = $2, tp1_hit = $3, tp1_at = $4, closed_at = $5, close_reason = $6,
       exit_price = $7, pnl_pct = $8, r_multiple = $9, mfe_pct = $10, mae_pct = $11, last_candle_time = $12,
       current_stop = $13, breakeven_moved = $14, trailing_active = $15, peak_pct = $16, last_milestone = $17,
       last_price = $18
     WHERE id = $1 AND status = 'open'`,
    [
      row.id, after.closed ? "closed" : "open", after.tp1Hit,
      after.tp1At ? new Date(after.tp1At) : null,
      after.closedAt ? new Date(after.closedAt) : null, after.closeReason, after.exitPrice,
      result.pnlPct, result.r, after.mfePct, after.maePct, after.lastCandleTime,
      after.currentStop, after.breakevenMoved, after.trailingActive, after.peakPct, after.lastMilestone,
      mark ?? null,
    ],
  );
  for (const e of events) {
    const detail: Record<string, unknown> = { ...e, currentStop: after.currentStop, peakPct: after.peakPct };
    if (e.kind === "closed") Object.assign(detail, { pnlPct: result.pnlPct, r: result.r, tp1Hit: after.tp1Hit });
    await insertEvent(row.id, eventKey(row.id, e), e.kind, e.price, detail, e.at);
  }
}

let busy = false;

/** One pass over every open trade. */
export async function trackOpenTrades(now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { rows } = await pool.query<OpenRow>("SELECT * FROM nh_signals WHERE status = 'open' ORDER BY id");
    await Promise.all(rows.map((row) => trackRow(row, now).catch((err) => {
      logger.warn({ err, id: row.id, symbol: row.symbol }, "nihilist: trade tracking failed");
    })));
  } finally {
    busy = false;
  }
}

/** Every 5 minutes, ~15 s after the 5m candle closes. */
export function startTracker(): void {
  let lastBar = 0;
  const tick = () => {
    const now = Date.now();
    const bar = Math.floor((now - 15_000) / SPAN) * SPAN;
    if (bar > lastBar) {
      lastBar = bar;
      void trackOpenTrades(now).catch((err) => logger.error({ err }, "nihilist: tracker pass failed"));
    }
    setTimeout(tick, 10_000);
  };
  tick();
}
