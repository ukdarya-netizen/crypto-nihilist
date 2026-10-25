import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { engineStatus } from "../engine/runtime";
import { cgRequest, coinglassGovernorStats, EXCHANGE } from "../market/coinglass";
import { apiHealth } from "../lib/apiHealth";

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
  res.json({ engine: engineStatus(), coinglass: coinglassGovernorStats(), health: apiHealth(), signals: rows[0] });
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

router.get("/nh/signals", async (req, res) => {
  const status = req.query.status === "closed" ? "closed" : "open";
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const { rows } = await pool.query(
    `SELECT * FROM nh_signals WHERE status = $1
     ORDER BY ${status === "open" ? "opened_at" : "closed_at"} DESC LIMIT $2`,
    [status, limit],
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
