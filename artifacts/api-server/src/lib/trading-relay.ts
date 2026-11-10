/**
 * Signals to the trading bot (owner 2026-11-02). Nihilist only SENDS signals;
 * size, leverage (10x), isolated margin, accounts and execution belong to the
 * trading bot. Three channels, the same as CAB:
 *   1. entry signal  — POST NIHILIST_TRADING_SIGNAL_URL when a live trade opens;
 *   2. commands      — POST NIHILIST_TRADING_COMMAND_URL: move_stop (break-even,
 *                      every trailing step) and close (stop / break-even /
 *                      trailing / holding time), numbered per signal;
 *   3. position sync — GET /api/trading/position-sync here, polled by the bot.
 * Header x-trading-token = NIHILIST_TRADING_TOKEN on all three.
 * Fail-closed: with no token or URL nothing is queued or sent; only the
 * published deployment sends (one sender). Every message is durable in
 * nh_trading_outbox and repeated with the same id until the receiver stores
 * it; 400/422 are kept as "quarantined" with the answer, never resent.
 */
import { pool } from "@workspace/db";
import { MAX_HOLD_MS, BREAKEVEN_AT_PCT } from "../engine/config";
import { TRAILING_ACTIVATION_PCT, TRAILING_GAP_PCT } from "../engine/trade";
import { logger } from "./logger";

export const RULES_VERSION = "nihilist-v1";
export const SOURCE = "CryptoNihilist";
const INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;

const signalUrl = () => process.env.NIHILIST_TRADING_SIGNAL_URL?.trim() || null;
const commandUrl = () => process.env.NIHILIST_TRADING_COMMAND_URL?.trim() || null;
export const tradingToken = () => process.env.NIHILIST_TRADING_TOKEN?.trim() || null;
/** Sending is on only in the published deployment with token and URLs set. */
export function relayEnabled(): boolean {
  return Boolean(tradingToken() && signalUrl() && commandUrl()) &&
    (process.env.REPLIT_DEPLOYMENT === "1" || process.env.NIHILIST_TRADING_IN_DEV === "1");
}

export const sourceSignalId = (id: number) => `nh-signal-${id}`;
/** BingX "ALT-USDT" → "ALTUSDT". */
export const wireSymbol = (symbol: string) => symbol.replace("-", "").toUpperCase();
/** Plain decimal string (never exponent notation). */
export function decimal(x: number): string {
  if (!Number.isFinite(x) || x <= 0) throw new Error("bad_price");
  const v = Number(x.toPrecision(12));
  const str = String(v);
  return /e/i.test(str) ? v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "") : str;
}

let ready: Promise<void> | null = null;
export function ensureRelayTable(): Promise<void> {
  ready ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nh_trading_outbox (
        id serial PRIMARY KEY,
        kind text NOT NULL,
        signal_id integer NOT NULL,
        message_id text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_http integer,
        last_answer text,
        created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz,
        CONSTRAINT nh_trading_outbox_message_id_unique UNIQUE (message_id)
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS nh_trading_outbox_due ON nh_trading_outbox (status, next_attempt_at)");
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

export type RelaySignal = {
  id: number; symbol: string; side: "long" | "short"; setup: string; htf: "4h" | "1d";
  entry: number; stop: number; signalAt: number;
  /** BTC: [TP 1, TP 2] at 1.5R and 3R. */
  btcTargets?: [number, number] | null;
};

export function signalPayload(s: RelaySignal): Record<string, unknown> {
  return {
    sourceSignalId: sourceSignalId(s.id),
    source: SOURCE,
    rulesVersion: RULES_VERSION,
    confirmationStatus: "confirmed",
    symbol: wireSymbol(s.symbol),
    side: s.side,
    setup: s.setup,
    signalAt: new Date(s.signalAt).toISOString(),
    entryPrice: decimal(s.entry),
    stopLoss: decimal(s.stop),
    // How Nihilist manages the trade; every change also arrives as a command.
    exitRules: s.btcTargets ? {
      // BTC (owner 2026-11-10, as BTC Bullet): TP 1 at 1.5R — 50% and stop to entry; TP 2 at 3R — the rest.
      noFixedTakeProfit: false,
      takeProfits: [{ price: decimal(s.btcTargets[0]), closeFractionOfInitial: 0.5 }, { price: decimal(s.btcTargets[1]), closeFractionOfInitial: 0.5 }],
      breakevenAfterFirstTake: true,
      maxHoldHours: MAX_HOLD_MS[s.htf] / 3_600_000,
      stopsFollowSourceCommands: true,
    } : {
      noFixedTakeProfit: true,
      breakevenAtPct: BREAKEVEN_AT_PCT,
      trailingActivationPct: TRAILING_ACTIVATION_PCT,
      trailingGapPercentagePoints: TRAILING_GAP_PCT,
      maxHoldHours: MAX_HOLD_MS[s.htf] / 3_600_000,
      stopsFollowSourceCommands: true,
    },
  };
}

/** Queues the entry signal of a live trade that was just opened. */
export async function enqueueSignal(s: RelaySignal): Promise<void> {
  if (!relayEnabled()) return;
  await ensureRelayTable();
  await pool.query(
    `INSERT INTO nh_trading_outbox (kind, signal_id, message_id, payload) VALUES ('signal', $1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING`,
    // releasedAt = the moment the signal is released (its message goes out): the trading
    // bot counts freshness from here, not from the bar close in signalAt (owner 2026-11-03).
    [s.id, sourceSignalId(s.id), JSON.stringify({ ...signalPayload(s), releasedAt: new Date().toISOString() })],
  );
}

export type CommandInput =
  | { type: "move_stop"; reason: "breakeven" | "trailing"; stopPrice: number; at: number }
  | { type: "close"; reason: "stop_loss" | "breakeven_stop" | "trailing_stop" | "profit" | "expired"; exitPrice: number | null; at: number;
      /** Partial close, share of the initial position (TP 1: 0.5). */
      fraction?: number };

/** Queues a command for a signal that was sent to the bot (no signal sent = no command). */
export async function enqueueCommand(signalId: number, symbol: string, c: CommandInput): Promise<void> {
  if (!relayEnabled()) return;
  await ensureRelayTable();
  const sent = await pool.query("SELECT 1 FROM nh_trading_outbox WHERE kind = 'signal' AND signal_id = $1", [signalId]);
  if (!sent.rowCount) return;
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM nh_trading_outbox WHERE kind = 'command' AND signal_id = $1", [signalId],
  );
  const sequence = (rows[0]?.n ?? 0) + 1;
  const commandId = `nh-${signalId}-${sequence}`;
  const payload: Record<string, unknown> = {
    commandId, sourceSignalId: sourceSignalId(signalId), symbol: wireSymbol(symbol), type: c.type, sequence,
    occurredAt: new Date(c.at).toISOString(), reason: c.reason,
    ...(c.type === "move_stop" ? { stopPrice: decimal(c.stopPrice) } : {}),
    ...(c.type === "close" && c.fraction !== undefined && c.fraction < 1 ? { partial: true, closeFractionOfInitial: c.fraction } : {}),
  };
  await pool.query(
    `INSERT INTO nh_trading_outbox (kind, signal_id, message_id, payload) VALUES ('command', $1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING`,
    [signalId, commandId, JSON.stringify(payload)],
  );
}

export type Receipt = "delivered" | "quarantined" | "retry";

/** Signal: any 2xx or 409 (already stored) is delivered. Command: only an explicit stored=true for this id. */
export function classifyReceipt(kind: "signal" | "command", status: number, body: unknown, messageId: string): Receipt {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (kind === "command") {
    if (b && b.stored === true && b.commandId === messageId && [200, 201, 202, 409].includes(status)) return "delivered";
  } else if ((status >= 200 && status < 300) || status === 409) {
    return "delivered";
  }
  if (status === 400 || status === 422) return "quarantined";
  return "retry";
}

export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.min(Math.max(attempts, 1) - 1, 10), MAX_BACKOFF_MS);

let delivering = false;
export async function deliverDue(): Promise<void> {
  if (delivering || !relayEnabled()) return;
  delivering = true;
  try {
    await ensureRelayTable();
    // Commands of a signal go only after its entry signal was delivered, in order.
    const { rows } = await pool.query<{ id: number; kind: "signal" | "command"; message_id: string; payload: unknown; attempts: number }>(
      `SELECT o.id, o.kind, o.message_id, o.payload, o.attempts FROM nh_trading_outbox o
       WHERE o.status = 'pending' AND o.next_attempt_at <= now()
         AND (o.kind = 'signal' OR EXISTS (
           SELECT 1 FROM nh_trading_outbox s WHERE s.kind = 'signal' AND s.signal_id = o.signal_id AND s.status = 'delivered'))
         AND NOT EXISTS (
           SELECT 1 FROM nh_trading_outbox p WHERE p.kind = 'command' AND p.signal_id = o.signal_id
             AND p.status = 'pending' AND p.id < o.id AND o.kind = 'command')
       ORDER BY o.id LIMIT 20`,
    );
    for (const m of rows) {
      const url = m.kind === "signal" ? signalUrl() : commandUrl();
      let status = 0; let body: unknown = null; let answer = "";
      try {
        const res = await fetch(url!, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-trading-token": tradingToken()! },
          body: JSON.stringify(m.payload),
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        answer = (await res.text()).slice(0, 500);
        try { body = JSON.parse(answer); } catch { body = null; }
      } catch (err) {
        answer = err instanceof Error ? err.message.slice(0, 200) : "network_error";
      }
      const receipt = classifyReceipt(m.kind, status, body, m.message_id);
      const attempts = m.attempts + 1;
      await pool.query(
        `UPDATE nh_trading_outbox SET status = $2, attempts = $3, last_http = $4, last_answer = $5,
           next_attempt_at = $6, delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END WHERE id = $1`,
        [m.id, receipt === "retry" ? "pending" : receipt, attempts, status || null, answer,
          new Date(Date.now() + (receipt === "retry" ? backoffMs(attempts) : 0))],
      );
      if (receipt !== "delivered") logger.warn({ id: m.message_id, status, receipt }, "nihilist: trading bot did not store the message");
    }
  } catch (err) {
    logger.warn({ err }, "nihilist: trading relay pass failed");
  } finally {
    delivering = false;
  }
}

export function startTradingRelay(): void {
  if (!relayEnabled()) {
    logger.info("nihilist: trading relay off (needs NIHILIST_TRADING_TOKEN, NIHILIST_TRADING_SIGNAL_URL, NIHILIST_TRADING_COMMAND_URL; published deployment)");
    return;
  }
  setInterval(() => void deliverDue(), INTERVAL_MS).unref?.();
}

/** Close reason of the tracker → command reason. */
export function closeReason(reason: string | null): "stop_loss" | "breakeven_stop" | "trailing_stop" | "profit" | "expired" {
  return reason === "take" ? "profit" : reason === "trailing" ? "trailing_stop" : reason === "breakeven" ? "breakeven_stop" : reason === "timeout" ? "expired" : "stop_loss";
}
