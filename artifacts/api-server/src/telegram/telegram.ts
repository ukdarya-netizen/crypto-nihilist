/**
 * Telegram delivery (as in BTC Bullet): every event of a LIVE trade is sent
 * to the channel (NIHILIST_TELEGRAM_CHANNEL) and to every private chat that
 * subscribed with /start before the event. One delivery row per recipient:
 * a success is never repeated when others fail; up to 8 attempts each.
 * Shadow trades (setup not in LIVE_SETUPS) never leave the dashboard.
 * Only signals and the daily/weekly/monthly reports go out: no service,
 * restart or API-outage messages.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { formatEvent, type EventForText, type SignalForText } from "./format";
import { startReports } from "./reports";
import { sendMessage, signalChannel, subscriptionCommand, telegramCall, telegramEnabled, TelegramError, type TelegramUpdate } from "./transport";

const MAX_ATTEMPTS = 8;
let delivering = false;

type QueueRow = SignalForText & EventForText & { event_id: number; signal_live: boolean };

async function enqueue(): Promise<QueueRow[]> {
  const { rows } = await pool.query<QueueRow>(
    `SELECT e.id AS event_id, e.kind, e.price, e.detail, e.created_at, s.live AS signal_live,
            s.symbol, s.setup, s.htf, s.ltf, s.side, s.entry, s.stop, s.tp1, s.block_top, s.block_bottom,
            s.block_scope, s.opened_at, s.targets_source
     FROM nh_signal_events e JOIN nh_signals s ON s.id = e.signal_id
     WHERE e.telegram_sent_at IS NULL AND e.telegram_attempts < $1
     ORDER BY e.id LIMIT 20`,
    [MAX_ATTEMPTS],
  );
  const channel = signalChannel();
  for (const row of rows) {
    if (!row.signal_live) {
      await pool.query("UPDATE nh_signal_events SET telegram_sent_at = now() WHERE id = $1", [row.event_id]);
      continue;
    }
    const text = formatEvent(row, row);
    const subs = await pool.query<{ chat_id: string }>(
      "SELECT chat_id FROM nh_telegram_subscribers WHERE active AND subscribed_at <= $1", [row.created_at],
    );
    const recipients = [
      ...(channel ? [{ chat: channel, isChannel: true }] : []),
      ...subs.rows.map((s) => ({ chat: s.chat_id, isChannel: false })),
    ];
    for (const r of recipients) {
      await pool.query(
        `INSERT INTO nh_telegram_deliveries (event_id, chat_id, channel, text) VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id, chat_id) DO NOTHING`,
        [row.event_id, r.chat, r.isChannel, text],
      );
    }
    if (!recipients.length) {
      await pool.query("UPDATE nh_signal_events SET telegram_sent_at = now() WHERE id = $1", [row.event_id]);
    }
  }
  return rows.filter((r) => r.signal_live);
}

async function sendPending(): Promise<void> {
  const { rows } = await pool.query<{ id: number; chat_id: string; channel: boolean; text: string; attempts: number }>(
    `SELECT id, chat_id, channel, text, attempts FROM nh_telegram_deliveries
     WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY id LIMIT 20`,
  );
  for (const d of rows) {
    if (!d.channel) {
      const sub = await pool.query("SELECT 1 FROM nh_telegram_subscribers WHERE chat_id = $1 AND active", [d.chat_id]);
      if (!sub.rowCount) {
        await pool.query("UPDATE nh_telegram_deliveries SET status = 'skipped' WHERE id = $1", [d.id]);
        continue;
      }
    }
    try {
      await sendMessage(d.chat_id, d.text);
      await pool.query("UPDATE nh_telegram_deliveries SET status = 'sent', sent_at = now() WHERE id = $1", [d.id]);
    } catch (err) {
      const attempts = d.attempts + 1;
      const blocked = !d.channel && err instanceof TelegramError && err.code === 403;
      if (blocked) await pool.query("UPDATE nh_telegram_subscribers SET active = false, updated_at = now() WHERE chat_id = $1", [d.chat_id]);
      const waitMs = Math.max(3000 * 2 ** Math.min(attempts, 8), err instanceof TelegramError ? err.retryAfter * 1000 : 0);
      await pool.query(
        "UPDATE nh_telegram_deliveries SET attempts = $2, status = $3, next_attempt_at = $4 WHERE id = $1",
        [d.id, attempts, blocked ? "skipped" : attempts >= MAX_ATTEMPTS ? "failed" : "pending", new Date(Date.now() + waitMs)],
      );
      logger.warn({ err, deliveryId: d.id, attempts }, "nihilist: Telegram delivery failed");
    }
    await new Promise((r) => setTimeout(r, 100)); // below the bot-wide send limit
  }
}

async function settle(events: QueueRow[]): Promise<void> {
  for (const e of events) {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM nh_telegram_deliveries WHERE event_id = $1", [e.event_id]);
    if (!rows.length || rows.some((r) => r.status === "pending")) continue;
    if (rows.some((r) => r.status === "failed")) {
      await pool.query("UPDATE nh_signal_events SET telegram_attempts = $2 WHERE id = $1", [e.event_id, MAX_ATTEMPTS]);
    } else {
      await pool.query("UPDATE nh_signal_events SET telegram_sent_at = now() WHERE id = $1", [e.event_id]);
    }
  }
}

export async function deliverNext(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    const events = await enqueue();
    await sendPending();
    await settle(events);
  } finally {
    delivering = false;
  }
}

// ---------------- /start and /stop ----------------

let polling = false;

async function poll(): Promise<void> {
  const state = await pool.query<{ next_update_id: string }>("SELECT next_update_id FROM nh_telegram_state WHERE key = 'updates'");
  let offset = Number(state.rows[0]?.next_update_id ?? 0);
  while (polling) {
    try {
      const updates = await telegramCall<TelegramUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const update of updates) {
        if (update.update_id < offset) continue;
        const command = subscriptionCommand(update);
        if (command && update.message) {
          await pool.query(
            `INSERT INTO nh_telegram_subscribers (chat_id, active, subscribed_at, updated_at) VALUES ($1, $2, now(), now())
             ON CONFLICT (chat_id) DO UPDATE SET active = EXCLUDED.active, subscribed_at = now(), updated_at = now()`,
            [String(update.message.chat.id), command === "start"],
          );
        }
        offset = update.update_id + 1;
        await pool.query(
          `INSERT INTO nh_telegram_state (key, next_update_id) VALUES ('updates', $1)
           ON CONFLICT (key) DO UPDATE SET next_update_id = EXCLUDED.next_update_id`,
          [offset],
        );
        if (command && update.message) {
          const channel = signalChannel();
          await sendMessage(String(update.message.chat.id), command === "start"
            ? `Вы подписаны на сигналы NIHILYST.${channel ? ` Они приходят сюда и в канал ${channel}.` : ""} Отписаться: /stop.`
            : "Подписка на сигналы NIHILYST отключена. Подписаться снова: /start.").catch(() => {
            logger.warn("nihilist: subscription saved, confirmation not delivered");
          });
        }
      }
    } catch (err) {
      if (err instanceof TelegramError && err.code === 409) {
        logger.error("nihilist: Telegram polling stopped — another poller or webhook uses this bot token");
        polling = false;
        return;
      }
      logger.warn({ err }, "nihilist: Telegram polling failed, retrying");
      await new Promise((r) => setTimeout(r, err instanceof TelegramError ? Math.max(5000, err.retryAfter * 1000) : 5000));
    }
  }
}

export function startTelegram(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn("nihilist: Telegram disabled — TELEGRAM_BOT_TOKEN not set");
    return;
  }
  if (!telegramEnabled()) {
    logger.warn("nihilist: Telegram off in the dev workspace — the published deployment sends (NIHILIST_TELEGRAM_IN_DEV=1 to force)");
    return;
  }
  if (!polling) {
    polling = true;
    void poll().catch((err) => { polling = false; logger.error({ err }, "nihilist: Telegram polling stopped"); });
  }
  startReports();
  setInterval(() => void deliverNext().catch((err) => logger.warn({ err }, "nihilist: Telegram delivery pass failed")), 3000).unref?.();
}
