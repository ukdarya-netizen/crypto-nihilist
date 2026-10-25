import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { engineStatus } from "../engine/runtime";
import { cgRequest, coinglassGovernorStats, EXCHANGE } from "../market/coinglass";
import { apiHealth } from "../lib/apiHealth";
import { buildJournal, tradeStatus, type JournalRow } from "../stats/journal";

const router: IRouter = Router();

const days = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : fallback;
};

router.get("/nh/status", async (_req, res) => {
  const { rows } = await pool.query<{ open: number; closed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'closed')::int AS closed FROM nh_signals`,
  );
  const telegram = { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN), channel: process.env.NIHILIST_TELEGRAM_CHANNEL?.trim() || null };
  res.json({ engine: engineStatus(), coinglass: coinglassGovernorStats(), health: apiHealth(), signals: rows[0], telegram });
});

/** Results per setup over closed trades of the last N days (by close time). */
router.get("/nh/stats", async (req, res) => {
  const d = days(req.query.days, 30);
  const { rows } = await pool.query(
    `SELECT setup,
            count(*)::int AS trades,
            count(*) FILTER (WHERE pnl_pct > 0)::int AS wins,
            count(*) FILTER (WHERE tp1_hit)::int AS tp1,
            count(*) FILTER (WHERE close_reason = 'stop')::int AS stops,
            count(*) FILTER (WHERE close_reason = 'timeout')::int AS timeouts,
            round(avg(r_multiple)::numeric, 3)::float AS avg_r,
            round(sum(r_multiple)::numeric, 3)::float AS sum_r,
            round(avg(pnl_pct)::numeric, 3)::float AS avg_pnl_pct
     FROM nh_signals WHERE status = 'closed' AND closed_at > now() - make_interval(days => $1)
     GROUP BY setup ORDER BY setup`,
    [d],
  );
  const open = await pool.query(
    "SELECT setup, count(*)::int AS open FROM nh_signals WHERE status = 'open' GROUP BY setup",
  );
  res.json({ days: d, setups: rows, open: open.rows });
});

/** Closed-trade result per UTC day (for the overview chart). */
router.get("/nh/stats/daily", async (req, res) => {
  const d = days(req.query.days, 30);
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', closed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            count(*)::int AS trades,
            count(*) FILTER (WHERE pnl_pct > 0)::int AS wins,
            round(sum(r_multiple)::numeric, 3)::float AS sum_r,
            round(sum(pnl_pct)::numeric, 3)::float AS sum_pnl_pct
     FROM nh_signals WHERE status = 'closed' AND closed_at > now() - make_interval(days => $1)
     GROUP BY 1 ORDER BY 1`,
    [d],
  );
  res.json({ days: d, daily: rows });
});

router.get("/nh/signals", async (req, res) => {
  const status = req.query.status === "closed" ? "closed" : "open";
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const setup = typeof req.query.setup === "string" && req.query.setup ? req.query.setup : null;
  // Open trades carry last_price: the close of the last 5m candle the tracker processed.
  const { rows } = await pool.query(
    `SELECT s.* FROM nh_signals s WHERE s.status = $1 AND ($3::text IS NULL OR s.setup = $3)
     ORDER BY ${status === "open" ? "s.opened_at" : "s.closed_at"} DESC LIMIT $2`,
    [status, limit, setup],
  );
  res.json({ signals: rows });
});

router.get("/nh/decisions", async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const decision = typeof req.query.decision === "string" ? req.query.decision : null;
  const { rows } = await pool.query(
    `SELECT * FROM nh_decisions WHERE ($1::text IS NULL OR decision = $1)
     ORDER BY created_at DESC LIMIT $2`,
    [decision, limit],
  );
  const reasons = await pool.query(
    `SELECT coalesce(reason, decision) AS reason, count(*)::int AS n FROM nh_decisions
     WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`,
  );
  res.json({ decisions: rows, reasons7d: reasons.rows });
});

const liveOnly = (value: unknown) => value === "1" || value === "true";

/**
 * Overview in the CAB layout: counters, profit counter, win rate, BE +5/+8/+10,
 * averages, best trade, per-setup table and the daily chart. Cohort = signals
 * opened in the last N days; `live=1` = only setups published to Telegram.
 */
router.get("/nh/journal", async (req, res) => {
  const d = days(req.query.days, 30);
  const live = liveOnly(req.query.live);
  const { rows } = await pool.query<JournalRow>(
    `SELECT id, symbol, setup, side, status, live, close_reason, pnl_pct, r_multiple, peak_pct, mfe_pct, opened_at, closed_at
     FROM nh_signals WHERE opened_at > now() - make_interval(days => $1) AND (NOT $2 OR live)`,
    [d, live],
  );
  const counters = await pool.query<{ today: number; total: number }>(
    `SELECT count(*) FILTER (WHERE opened_at >= date_trunc('day', now()))::int AS today, count(*)::int AS total
     FROM nh_signals WHERE (NOT $1 OR live)`,
    [live],
  );
  // Daily result by close day (UTC) of the cohort's closed trades.
  const byDay = new Map<string, { day: string; trades: number; wins: number; pnl: number; r: number }>();
  for (const row of rows) {
    if (row.status !== "closed" || !row.closed_at) continue;
    const day = new Date(row.closed_at).toISOString().slice(0, 10);
    const item = byDay.get(day) ?? { day, trades: 0, wins: 0, pnl: 0, r: 0 };
    item.trades += 1;
    if (Number(row.pnl_pct) > 0) item.wins += 1;
    item.pnl += Number(row.pnl_pct ?? 0);
    item.r += Number(row.r_multiple ?? 0);
    byDay.set(day, item);
  }
  const daily = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
    .map((x) => ({ ...x, pnl: Math.round(x.pnl * 100) / 100, r: Math.round(x.r * 100) / 100 }));
  res.json({ days: d, live, counters: counters.rows[0], ...buildJournal(rows), daily });
});

/** Signal history (open and closed) with filters, newest first. */
router.get("/nh/history", async (req, res) => {
  const d = days(req.query.days, 30);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const setup = typeof req.query.setup === "string" && req.query.setup ? req.query.setup : null;
  const symbol = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim().toUpperCase()}%` : null;
  const { rows } = await pool.query(
    `SELECT * FROM nh_signals
     WHERE opened_at > now() - make_interval(days => $1) AND ($2::text IS NULL OR setup = $2)
       AND ($3::text IS NULL OR symbol LIKE $3) AND (NOT $4 OR live)
     ORDER BY opened_at DESC LIMIT $5`,
    [d, setup, symbol, liveOnly(req.query.live), limit],
  );
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const filtered = status ? rows.filter((r) => tradeStatus(r as JournalRow) === status) : rows;
  res.json({ signals: filtered.map((r) => ({ ...r, trade_status: tradeStatus(r as JournalRow) })) });
});

/** Lifecycle of one trade (what went to Telegram, step by step). */
router.get("/nh/signals/:id/events", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) { res.status(400).json({ error: "bad_id" }); return; }
  const { rows } = await pool.query(
    "SELECT id, kind, price, detail, created_at, telegram_sent_at FROM nh_signal_events WHERE signal_id = $1 ORDER BY created_at, id",
    [id],
  );
  res.json({ events: rows });
});

/** Raw CoinGlass answer for one symbol (to verify candles against the chart). */
router.get("/nh/diag/candles", async (req, res) => {
  const symbol = String(req.query.symbol ?? "BTC-USDT");
  const interval = String(req.query.interval ?? "4h");
  const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
  const result = await cgRequest("/api/futures/price/history", { exchange: EXCHANGE, symbol, interval, limit });
  res.json(result);
});

router.get("/nh/diag/pairs", async (_req, res) => {
  const result = await cgRequest("/api/futures/supported-exchange-pairs", { exchange: EXCHANGE });
  if (!result.ok) { res.json(result); return; }
  const data = result.data as Record<string, unknown[]> | unknown[];
  const rows = Array.isArray(data) ? data : data?.[EXCHANGE] ?? [];
  res.json({ ok: true, count: Array.isArray(rows) ? rows.length : 0, sample: Array.isArray(rows) ? rows.slice(0, 3) : rows });
});

export default router;
