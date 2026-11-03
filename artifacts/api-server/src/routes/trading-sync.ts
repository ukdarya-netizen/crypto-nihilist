/**
 * Position sync for the trading bot (owner 2026-11-02, as CAB's
 * /api/trading/position-sync): every Nihilist signal sent to the bot with its
 * current state, so the bot can reconcile what to hold and what to close even
 * if a command was missed. Header x-trading-token = NIHILIST_TRADING_TOKEN.
 * Pages by signal id (?afterId=), 200 per page.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { ensureRelayTable, sourceSignalId, tradingToken, wireSymbol } from "../lib/trading-relay";
import { HISTORY_DAYS, loadReport, runStrategyReport, strategyReportRunning } from "../analysis/strategy-report";

const PAGE = 200;

export function tokenMatches(given: string | undefined, expected: string | null): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

type Row = {
  id: number; symbol: string; side: "long" | "short"; status: string; close_reason: string | null; opened_at: Date;
  closed_at: Date | null; entry: number; stop: number; current_stop: number | null; exit_price: number | null;
  pnl_pct: number | null; peak_pct: number; breakeven_moved: boolean; trailing_active: boolean; delivered_at: Date | null;
};

export const sourceAction = (r: { status: string; closed_at: Date | null }) =>
  r.status === "open" ? "hold" : r.status === "closed" && r.closed_at ? "close" : "review";

const router: IRouter = Router();
router.get("/trading/position-sync", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const expected = tradingToken();
  if (!expected) { res.status(503).json({ error: "trading_bot_access_not_configured" }); return; }
  if (!tokenMatches(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return; }
  const raw = req.query.afterId;
  if (raw !== undefined && (typeof raw !== "string" || !/^(0|[1-9]\d{0,9})$/.test(raw))) {
    res.status(400).json({ error: "invalid_after_id" }); return;
  }
  try {
    await ensureRelayTable();
    const { rows } = await pool.query<Row>(
      `SELECT s.id, s.symbol, s.side, s.status, s.close_reason, s.opened_at, s.closed_at, s.entry, s.stop, s.current_stop,
              s.exit_price, s.pnl_pct, s.peak_pct, s.breakeven_moved, s.trailing_active, o.delivered_at
       FROM nh_trading_outbox o JOIN nh_signals s ON s.id = o.signal_id
       WHERE o.kind = 'signal' AND o.status = 'delivered' AND s.id > $1 ORDER BY s.id LIMIT $2`,
      [raw === undefined ? 0 : Number(raw), PAGE + 1],
    );
    const page = rows.slice(0, PAGE);
    res.json({
      asOf: new Date().toISOString(),
      positions: page.map((r) => ({
        sourceSignalId: sourceSignalId(r.id),
        symbol: wireSymbol(r.symbol),
        side: r.side,
        signalAt: r.opened_at.toISOString(),
        botEnqueuedAt: r.delivered_at?.toISOString() ?? null,
        initialStopPrice: r.stop,
        sourceStatus: r.status === "open" ? (r.trailing_active ? "trailing" : r.breakeven_moved ? "breakeven" : "active") : r.close_reason ?? "closed",
        sourceAction: sourceAction(r),
        sourceClosedAt: r.closed_at?.toISOString() ?? null,
        sourceEntryPrice: r.entry,
        sourceStopLossPrice: r.current_stop ?? r.stop,
        sourceExitPrice: r.exit_price,
        sourcePnlPercent: r.pnl_pct,
        sourcePeakPct: r.peak_pct,
      })),
      nextAfterId: rows.length > PAGE ? page[page.length - 1]!.id : null,
    });
  } catch {
    res.status(503).json({ error: "position_sync_unavailable" });
  }
});

// The trading bot shows Nihilist's strategy report on its «Стратегии» page (owner 2026-11-03).
router.get("/trading/strategy-report", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const expected = tradingToken();
  if (!expected) { res.status(503).json({ error: "trading_bot_access_not_configured" }); return; }
  if (!tokenMatches(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return; }
  try {
    res.json({ running: strategyReportRunning(), report: await loadReport(), historyDays: HISTORY_DAYS });
  } catch {
    res.status(503).json({ error: "report_unavailable" });
  }
});
router.post("/trading/strategy-report/run", (req, res) => {
  const expected = tradingToken();
  if (!expected) { res.status(503).json({ error: "trading_bot_access_not_configured" }); return; }
  if (!tokenMatches(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return; }
  if (strategyReportRunning()) { res.status(409).json({ error: "already_running" }); return; }
  void runStrategyReport({});
  res.status(202).json({ started: true });
});

export default router;
