/**
 * Sends the daily / weekly / monthly reports (see report-format.ts for the
 * schedule and texts) through the signal delivery queue.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { signalChannel } from "./transport";
import { formatDailyReport, formatPeriodReport, latestSchedule, reportEventId, type ReportRow, type Schedule } from "./report-format";

export * from "./report-format";

const LATE_WINDOW_MS = 86_400_000;

const COLUMNS = `id, symbol, setup, side, status, live, close_reason, pnl_pct, r_multiple, peak_pct, mfe_pct,
  opened_at, closed_at, entry, last_price`;

async function closedBetween(from: number, to: number): Promise<ReportRow[]> {
  const { rows } = await pool.query<ReportRow>(
    `SELECT ${COLUMNS} FROM nh_signals WHERE live AND status = 'closed' AND closed_at >= $1 AND closed_at < $2 ORDER BY closed_at`,
    [new Date(from), new Date(to)],
  );
  return rows;
}

export async function buildReport(s: Schedule): Promise<string> {
  const closed = await closedBetween(s.from, s.to);
  if (s.kind !== "daily") return formatPeriodReport(s.kind, closed, s.from, s.to);
  const { rows: open } = await pool.query<ReportRow>(
    `SELECT ${COLUMNS} FROM nh_signals WHERE live AND status = 'open' ORDER BY opened_at`,
  );
  return formatDailyReport(closed, open, s.at);
}

/** Claims the period once (atomic); false when it was already claimed. */
async function claim(s: Schedule): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     WHERE nh_state.value IS DISTINCT FROM EXCLUDED.value`,
    [`report:${s.kind}`, JSON.stringify(s.period)],
  );
  return (rowCount ?? 0) > 0;
}

async function enqueueReport(s: Schedule, text: string): Promise<number> {
  const channel = signalChannel();
  const subs = await pool.query<{ chat_id: string }>("SELECT chat_id FROM nh_telegram_subscribers WHERE active");
  const recipients = [
    ...(channel ? [{ chat: channel, isChannel: true }] : []),
    ...subs.rows.map((r) => ({ chat: r.chat_id, isChannel: false })),
  ];
  for (const r of recipients) {
    await pool.query(
      `INSERT INTO nh_telegram_deliveries (event_id, chat_id, channel, text) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, chat_id) DO NOTHING`,
      [reportEventId(s), r.chat, r.isChannel, text],
    );
  }
  return recipients.length;
}

/** First moment reports were enabled: no report for a time before it (no empty catch-up on launch). */
async function reportsSince(now: number): Promise<number> {
  await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ('reports:since', $1::jsonb, now()) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(now)],
  );
  const { rows } = await pool.query<{ value: number }>("SELECT value FROM nh_state WHERE key = 'reports:since'");
  return Number(rows[0]?.value ?? now);
}

export async function runReports(now = Date.now()): Promise<void> {
  const since = await reportsSince(now);
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    const s = latestSchedule(kind, now);
    if (now - s.at >= LATE_WINDOW_MS || s.at < since) continue;
    try {
      if (!await claim(s)) continue;
      const text = await buildReport(s);
      const recipients = await enqueueReport(s, text);
      logger.info({ kind, period: s.period, recipients }, "nihilist: report queued");
    } catch (err) {
      logger.warn({ err, kind }, "nihilist: report failed");
    }
  }
}

export function startReports(): void {
  const tick = () => void runReports().catch((err) => logger.warn({ err }, "nihilist: report pass failed"));
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, 60_000).unref?.();
}
