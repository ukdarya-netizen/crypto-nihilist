/**
 * Candles per symbol and interval, in memory and in `nh_candles`.
 *
 * CoinGlass budget: after the one-time deep backfill every symbol costs ONE
 * request per 30 minutes (the last few 30m bars). 1h / 4h / 1d bars are
 * built from the stored 30m bars when every 30m bar of that period is
 * present; otherwise that interval is fetched directly. Only closed bars are
 * ever stored or used.
 */
import { pool } from "@workspace/db";
import { INTERVAL_MS, aggregateFrom30m, closedOnly, mergeCandles, type Candle, type Interval } from "../engine/candles";
import { getCandleHistory, getCandles } from "./coinglass";
import { logger } from "../lib/logger";

export const INTERVALS: Interval[] = ["30m", "1h", "4h", "1d"];
/** Bars kept per interval (30m ≈ 15 days, 1h ≈ 29 days, 4h ≈ 117 days, 1d ≈ 1.4 years). */
export const KEEP: Record<Interval, number> = { "5m": 0, "30m": 720, "1h": 700, "4h": 700, "1d": 500 };
/** A series shorter than this share of KEEP is backfilled (new listings simply have less). */
const BACKFILL_RATIO = 0.9;
const BACKFILL_RETRY_MS = 6 * 60 * 60_000;

export type Book = Record<Interval, Candle[]>;
const books = new Map<string, Book>();
const backfillTriedAt = new Map<string, number>();

export function book(symbol: string): Book {
  let b = books.get(symbol);
  if (!b) {
    b = { "5m": [], "30m": [], "1h": [], "4h": [], "1d": [] };
    books.set(symbol, b);
  }
  return b;
}

export function knownSymbols(): string[] {
  return [...books.keys()];
}

async function persist(symbol: string, interval: Interval, candles: Candle[]): Promise<void> {
  for (let i = 0; i < candles.length; i += 500) {
    const chunk = candles.slice(i, i + 500);
    const values: unknown[] = [];
    const rows = chunk.map((c, j) => {
      values.push(symbol, interval, c.t, c.o, c.h, c.l, c.c);
      const b = j * 7;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    });
    await pool.query(
      `INSERT INTO nh_candles (symbol, interval, t, o, h, l, c) VALUES ${rows.join(",")}
       ON CONFLICT (symbol, interval, t) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c`,
      values,
    );
  }
}

function put(symbol: string, interval: Interval, candles: Candle[], now: number): Candle[] {
  const b = book(symbol);
  const closed = closedOnly(candles, interval, now);
  const before = new Set(b[interval].map((c) => c.t));
  b[interval] = mergeCandles(b[interval], closed, KEEP[interval]);
  return closed.filter((c) => !before.has(c.t));
}

/** Loads stored candles of the given symbols into memory. */
export async function loadFromDb(symbols: string[], now = Date.now()): Promise<void> {
  if (!symbols.length) return;
  // One query per batch (PK order: symbol, interval, t), not one per symbol.
  const { rows } = await pool.query<{ symbol: string; interval: Interval; t: string; o: number; h: number; l: number; c: number }>(
    "SELECT symbol, interval, t, o, h, l, c FROM nh_candles WHERE symbol = ANY($1::text[]) ORDER BY symbol, interval, t",
    [symbols],
  );
  const grouped = new Map<string, Partial<Record<Interval, Candle[]>>>();
  for (const r of rows) {
    const g = grouped.get(r.symbol) ?? {};
    grouped.set(r.symbol, g);
    (g[r.interval] ??= []).push({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c });
  }
  for (const symbol of symbols) {
    const g = grouped.get(symbol) ?? {};
    for (const interval of INTERVALS) put(symbol, interval, g[interval] ?? [], now);
  }
}

/** Deep history for every interval that is short. Returns false when any request failed. */
export async function backfill(symbol: string, now = Date.now()): Promise<boolean> {
  const tried = backfillTriedAt.get(symbol);
  if (tried !== undefined && now - tried < BACKFILL_RETRY_MS) return true;
  let ok = true;
  for (const interval of INTERVALS) {
    if (book(symbol)[interval].length >= KEEP[interval] * BACKFILL_RATIO) continue;
    const history = await getCandleHistory(symbol, interval, KEEP[interval] + 1);
    if (history === null) { ok = false; continue; }
    const added = put(symbol, interval, history, now);
    if (added.length) await persist(symbol, interval, added);
  }
  backfillTriedAt.set(symbol, now);
  return ok;
}

export function needsBackfill(symbol: string): boolean {
  const b = books.get(symbol);
  return !b || INTERVALS.some((i) => b[i].length < KEEP[i] * BACKFILL_RATIO) && !backfillTriedAt.has(symbol);
}

/**
 * Every 30 minutes: last 30m bars from CoinGlass, then 1h/4h/1d built from
 * them (direct request only when a 30m bar of the period is missing).
 * Returns the newly closed bars per interval, or null when the 30m request failed.
 */
export async function refresh(symbol: string, now = Date.now()): Promise<Partial<Record<Interval, Candle[]>> | null> {
  // After a pause, ask for every bar missed (not just the last few), so no gap stays.
  const recent = await getCandles(symbol, "30m", gapLimit(book(symbol)["30m"], "30m", now, 6));
  if (recent === null) return null;
  const added: Partial<Record<Interval, Candle[]>> = {};
  const new30 = put(symbol, "30m", recent, now);
  if (new30.length) { added["30m"] = new30; await persist(symbol, "30m", new30); }
  for (const interval of ["1h", "4h", "1d"] as const) {
    const series = book(symbol)[interval];
    const last = series.length ? series[series.length - 1].t : null;
    const { bars, missing } = aggregateFrom30m(book(symbol)["30m"], interval, last, now);
    let fresh = put(symbol, interval, bars, now);
    if (missing !== null) {
      const direct = await getCandles(symbol, interval, gapLimit(series, interval, now, 3));
      if (direct !== null) fresh = [...fresh, ...put(symbol, interval, direct, now)];
      else logger.warn({ symbol, interval }, "nihilist: HTF bar unavailable");
    }
    if (fresh.length) { added[interval] = fresh; await persist(symbol, interval, fresh); }
  }
  return added;
}

function gapLimit(series: Candle[], interval: Interval, now: number, min: number): number {
  if (!series.length) return KEEP[interval];
  const missed = Math.ceil((now - series[series.length - 1].t) / INTERVAL_MS[interval]) + 2;
  return Math.max(min, Math.min(KEEP[interval], missed));
}

/** Drops rows older than what is kept (once a day is enough). */
export async function pruneDb(now = Date.now()): Promise<void> {
  for (const interval of INTERVALS) {
    const cutoff = now - (KEEP[interval] + 50) * INTERVAL_MS[interval];
    await pool.query("DELETE FROM nh_candles WHERE interval = $1 AND t < $2", [interval, cutoff]);
  }
}
