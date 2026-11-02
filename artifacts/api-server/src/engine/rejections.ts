/**
 * What happened to rejected setups (owner 2026-11-02): every rejection in
 * nh_decisions is followed after the moment it would have been entered —
 * did the price reach +10% in the trade direction before the stop or not.
 *
 * Per rejection: entry (close of the signal bar), the stop it would have had,
 * and on closed 30m candles from the candle store (no extra CoinGlass
 * requests) the first event within the holding window of its order block
 * (7 days for 4h, 21 days for 1D):
 *   plus10  — +10% from entry reached first;
 *   stop    — the stop reached first (in one candle with +10%: stop first,
 *             same_candle = true, so the count is conservative);
 *   none    — the window ended with neither;
 *   tracking — still inside the window;
 *   no_data — the store has no candles for the start (too old) or no entry.
 * Peak and worst move in the window are kept too. Rejections without a stop
 * (or with a stop on the wrong side) are followed for +10% and the peak only.
 * Never touches signals, stats or Telegram.
 */
import { pool } from "@workspace/db";
import { INTERVAL_MS } from "./candles";
import { followRejection, rejectionLevels, type DecisionRow, type RejectionFirst, type RejectionState } from "./rejection-follow";

export { REJECTION_TARGET_PCT } from "./rejection-follow";
import { MAX_HOLD_MS } from "./config";
import type { HtfInterval } from "./setups";
import { book } from "../market/candleStore";
import { logger } from "../lib/logger";

let ready: Promise<void> | null = null;
export function ensureRejectionTable(): Promise<void> {
  ready ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nh_rejection_outcomes (
        decision_id integer PRIMARY KEY,
        symbol text NOT NULL,
        setup text NOT NULL,
        side text NOT NULL,
        reason text NOT NULL,
        signal_at timestamptz NOT NULL,
        window_end timestamptz NOT NULL,
        entry double precision,
        stop double precision,
        status text NOT NULL DEFAULT 'tracking',
        first_event text,
        first_at timestamptz,
        same_candle boolean NOT NULL DEFAULT false,
        peak_pct double precision NOT NULL DEFAULT 0,
        low_pct double precision NOT NULL DEFAULT 0,
        last_candle_t bigint,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS nh_rejection_outcomes_status ON nh_rejection_outcomes (status)");
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

let running = false;

/** Adds new rejections and moves every open one forward. Called after each scan cycle. */
export async function trackRejections(now = Date.now()): Promise<{ added: number; updated: number }> {
  if (running) return { added: 0, updated: 0 };
  running = true;
  let added = 0, updated = 0;
  try {
    await ensureRejectionTable();
    const { rows: fresh } = await pool.query<DecisionRow>(
      `SELECT d.id, d.symbol, d.setup, d.bar_time, d.reason, d.details FROM nh_decisions d
       LEFT JOIN nh_rejection_outcomes o ON o.decision_id = d.id
       WHERE d.decision = 'rejected' AND o.decision_id IS NULL ORDER BY d.id LIMIT 2000`,
    );
    for (const d of fresh) {
      const [htf, ltf, sideRaw] = d.setup.split("_");
      const side = sideRaw === "short" ? "short" : "long";
      const ltfSpan = INTERVAL_MS[(ltf === "1h" ? "1h" : "30m")];
      const signalAt = Number(d.bar_time) + ltfSpan;
      const windowEnd = signalAt + MAX_HOLD_MS[(htf === "1d" ? "1d" : "4h") as HtfInterval];
      const { entry, stop } = rejectionLevels(d, book(d.symbol)[ltf === "1h" ? "1h" : "30m"]);
      const first30 = book(d.symbol)["30m"][0];
      const noData = entry === null || !first30 || first30.t > signalAt;
      await pool.query(
        `INSERT INTO nh_rejection_outcomes (decision_id, symbol, setup, side, reason, signal_at, window_end, entry, stop, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [d.id, d.symbol, d.setup, side, d.reason ?? "rejected", new Date(signalAt), new Date(windowEnd), entry, stop, noData ? "no_data" : "tracking"],
      );
      added += 1;
    }
    const { rows: open } = await pool.query<{
      decision_id: number; symbol: string; side: "long" | "short"; entry: number; stop: number | null; signal_at: Date; window_end: Date;
      first_event: RejectionFirst | null; first_at: Date | null; same_candle: boolean; peak_pct: number; low_pct: number; last_candle_t: string | null;
    }>("SELECT * FROM nh_rejection_outcomes WHERE status = 'tracking'");
    for (const r of open) {
      const candles = book(r.symbol)["30m"];
      if (!candles.length) continue;
      const before: RejectionState = {
        side: r.side, entry: r.entry, stop: r.stop, signalAt: r.signal_at.getTime(), windowEnd: r.window_end.getTime(),
        first: r.first_event, firstAt: r.first_at?.getTime() ?? null, sameCandle: r.same_candle,
        peakPct: r.peak_pct, lowPct: r.low_pct, lastCandleT: r.last_candle_t === null ? null : Number(r.last_candle_t),
      };
      const { state, done } = followRejection(before, candles, now);
      if (state.lastCandleT === before.lastCandleT && !done) continue;
      await pool.query(
        `UPDATE nh_rejection_outcomes SET status = $2, first_event = $3, first_at = $4, same_candle = $5, peak_pct = $6,
           low_pct = $7, last_candle_t = $8, updated_at = now() WHERE decision_id = $1`,
        [r.decision_id, done ? "done" : "tracking", state.first, state.firstAt ? new Date(state.firstAt) : null, state.sameCandle,
          Math.round(state.peakPct * 1000) / 1000, Math.round(state.lowPct * 1000) / 1000, state.lastCandleT],
      );
      updated += 1;
    }
  } catch (err) {
    logger.warn({ err }, "nihilist: rejection follow-up failed");
  } finally {
    running = false;
  }
  return { added, updated };
}
