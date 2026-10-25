import {
  bigint, boolean, doublePrecision, index, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex,
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

/** Virtual trades opened by the scanner (shadow: dashboard only, no Telegram). */
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

export type NhSignal = typeof nhSignals.$inferSelect;
