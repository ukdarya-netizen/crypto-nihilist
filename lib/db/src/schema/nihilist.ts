import {
  bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

/** BingX OHLC from CoinGlass (closed bars only), per symbol and interval. */
export const nhCandles = pgTable("nh_candles", {
  symbol: text("symbol").notNull(),
  interval: text("interval").notNull(),
  t: bigint("t", { mode: "number" }).notNull(),
  o: doublePrecision("o").notNull(),
  h: doublePrecision("h").notNull(),
  l: doublePrecision("l").notNull(),
  c: doublePrecision("c").notNull(),
}, (t) => [primaryKey({ columns: [t.symbol, t.interval, t.t] })]);

/** Key/value runtime state (universe, last cycle). */
export const nhState = pgTable("nh_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Virtual trades opened by the scanner. `live` = published to Telegram; a
 * shadow trade (live = false) is tracked and counted on the dashboard only.
 */
export const nhSignals = pgTable("nh_signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  setup: text("setup").notNull(),
  htf: text("htf").notNull(),
  ltf: text("ltf").notNull(),
  side: text("side").notNull(),
  status: text("status").notNull().default("open"),
  blockId: text("block_id").notNull(),
  blockTop: doublePrecision("block_top").notNull(),
  blockBottom: doublePrecision("block_bottom").notNull(),
  blockScope: text("block_scope").notNull(),
  barTime: bigint("bar_time", { mode: "number" }).notNull(),
  entry: doublePrecision("entry").notNull(),
  stop: doublePrecision("stop").notNull(),
  tp1: doublePrecision("tp1").notNull(),
  tp2: doublePrecision("tp2").notNull(),
  riskPct: doublePrecision("risk_pct").notNull(),
  rr1: doublePrecision("rr1").notNull(),
  targetsSource: text("targets_source").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  live: boolean("live").notNull().default(false),
  currentStop: doublePrecision("current_stop"),
  breakevenMoved: boolean("breakeven_moved").notNull().default(false),
  trailingActive: boolean("trailing_active").notNull().default(false),
  peakPct: doublePrecision("peak_pct").notNull().default(0),
  lastMilestone: doublePrecision("last_milestone").notNull().default(0),
  /** Close of the last 5m candle the tracker processed. */
  lastPrice: doublePrecision("last_price"),
  tp1Hit: boolean("tp1_hit").notNull().default(false),
  tp1At: timestamp("tp1_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closeReason: text("close_reason"),
  exitPrice: doublePrecision("exit_price"),
  pnlPct: doublePrecision("pnl_pct"),
  rMultiple: doublePrecision("r_multiple"),
  mfePct: doublePrecision("mfe_pct").notNull().default(0),
  maePct: doublePrecision("mae_pct").notNull().default(0),
  lastCandleTime: bigint("last_candle_time", { mode: "number" }),
  details: jsonb("details").notNull().default({}),
}, (t) => [
  uniqueIndex("nh_signals_unique_block").on(t.symbol, t.setup, t.blockId),
  index("nh_signals_status").on(t.status),
]);

/** Every CHoCH inside an active HTF block that was evaluated: accepted or rejected with the reason. */
export const nhDecisions = pgTable("nh_decisions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  setup: text("setup").notNull(),
  barTime: bigint("bar_time", { mode: "number" }).notNull(),
  decision: text("decision").notNull(),
  reason: text("reason"),
  blockId: text("block_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  details: jsonb("details").notNull().default({}),
}, (t) => [
  uniqueIndex("nh_decisions_unique").on(t.symbol, t.setup, t.barTime, t.blockId),
  index("nh_decisions_created").on(t.createdAt),
]);

/** Lifecycle events of a trade (opened, milestones, TP1, trailing, closed); Telegram queue. */
export const nhSignalEvents = pgTable("nh_signal_events", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id").notNull(),
  eventKey: text("event_key").notNull(),
  kind: text("kind").notNull(),
  price: doublePrecision("price"),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  telegramSentAt: timestamp("telegram_sent_at", { withTimezone: true }),
  telegramAttempts: integer("telegram_attempts").notNull().default(0),
}, (t) => [
  uniqueIndex("nh_signal_events_key").on(t.eventKey),
  index("nh_signal_events_unsent").on(t.telegramSentAt),
]);

/** Private chats subscribed with /start (unsubscribe with /stop). */
export const nhTelegramSubscribers = pgTable("nh_telegram_subscribers", {
  chatId: text("chat_id").primaryKey(),
  active: boolean("active").notNull().default(true),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** getUpdates cursor. */
export const nhTelegramState = pgTable("nh_telegram_state", {
  key: text("key").primaryKey(),
  nextUpdateId: bigint("next_update_id", { mode: "number" }).notNull().default(0),
});

/** One row per event and recipient; a success is never re-sent. */
export const nhTelegramDeliveries = pgTable("nh_telegram_deliveries", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull(),
  chatId: text("chat_id").notNull(),
  channel: boolean("channel").notNull().default(false),
  text: text("text").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("nh_telegram_deliveries_unique").on(t.eventId, t.chatId),
  index("nh_telegram_deliveries_pending").on(t.status, t.nextAttemptAt),
]);

export type NhSignal = typeof nhSignals.$inferSelect;
