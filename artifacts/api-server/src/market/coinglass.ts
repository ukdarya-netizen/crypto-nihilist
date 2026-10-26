/**
 * CoinGlass v4 client for Crypto Nihilist: BingX perpetual universe and
 * BingX OHLC candles. Owner rule: candles only from CoinGlass, no substitute
 * source; a failed request is `null` and that symbol is simply not evaluated.
 *
 * Request governor (as AltBullet's): a fixed minimum gap between request
 * starts (plan budget), at most MAX_IN_FLIGHT concurrently, a 429 puts every
 * request into a growing cooldown (max 60 s), keys rotate round-robin.
 * Use a CoinGlass key of its own (NIHILIST_COINGLASS_API_KEY) so this bot
 * never eats AltBullet's per-key rate limit.
 */
import { recordFailure, recordSuccess } from "../lib/apiHealth";
import { normalizeCandles, type Candle, type Interval } from "../engine/candles";

const BASE = "https://open-api-v4.coinglass.com";
/** STANDARD plan = 300 req/min per key; 250 ms ≈ 240/min = 80% of it. */
const MIN_GAP_MS = Number(process.env.COINGLASS_MIN_GAP_MS ?? 250);
const MAX_IN_FLIGHT = 4;
const MAX_COOLDOWN_MS = 60_000;
export const EXCHANGE = "BingX";

function keys(): string[] {
  return [process.env.NIHILIST_COINGLASS_API_KEY, process.env.COINGLASS_API_KEY]
    .map((k) => k?.trim())
    .filter((k): k is string => Boolean(k))
    .filter((k, i, all) => all.indexOf(k) === i);
}

let keyIndex = 0;
let nextStartAt = 0;
let cooldownUntil = 0;
let consecutive429 = 0;
let inFlight = 0;
const stats = { started: 0, ok: 0, failed: 0, rateLimited: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function admit(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const wait = Math.max(nextStartAt - now, cooldownUntil - now, 0);
    if (wait === 0 && inFlight < MAX_IN_FLIGHT) {
      nextStartAt = now + MIN_GAP_MS;
      inFlight += 1;
      return;
    }
    await sleep(Math.max(wait, 50));
  }
}

/**
 * The 30-minute scan refreshes ~1,200 coins through CoinGlass in a few
 * minutes; signals depend on it. Background metric backfills wait while it
 * runs, so they never delay a scan.
 */
let scanBusy = false;
export function setScanBusy(value: boolean): void { scanBusy = value; }
export async function waitForScanIdle(maxMs = 10 * 60_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (scanBusy && Date.now() < until) await sleep(2_000);
}

export type CgResult = { ok: true; data: unknown } | { ok: false; error: string };

const MAX_429_RETRIES = 4;

/**
 * One GET with the raw outcome. A rate-limit answer (HTTP 429 or code 429 in
 * a 200 body) waits out the shared cooldown and retries, up to 4 times; any
 * other failure is returned at once. Never throws.
 */
export async function cgRequest(
  path: string, params: Record<string, string | number>, opts: { health?: boolean } = {},
): Promise<CgResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await cgRequestOnce(path, params, opts.health !== false);
    if (result.ok || !result.rateLimited || attempt >= MAX_429_RETRIES) return result;
  }
}

type CgAttempt = CgResult & { rateLimited?: boolean };

async function cgRequestOnce(path: string, params: Record<string, string | number>, health = true): Promise<CgAttempt> {
  const all = keys();
  if (all.length === 0) {
    recordFailure("coinglass", "NIHILIST_COINGLASS_API_KEY не задан");
    return { ok: false, error: "no_api_key" };
  }
  await admit();
  stats.started += 1;
  const key = all[keyIndex++ % all.length]!;
  try {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: { "CG-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { code?: unknown; msg?: unknown; data?: unknown } | null;
    // CoinGlass also signals the limit as HTTP 200 with code 429 in the body.
    if (res.status === 429 || String(body?.code) === "429") {
      stats.rateLimited += 1;
      consecutive429 += 1;
      cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, 2_000 * 2 ** (consecutive429 - 1));
      return { ok: false, error: `${path}: rate limited (429)`, rateLimited: true };
    }
    if (!res.ok || String(body?.code) !== "0") {
      stats.failed += 1;
      const error = `${path}: HTTP ${res.status} code ${String(body?.code)} ${String(body?.msg ?? "")}`;
      // Metric reads of coins CoinGlass does not cover are not an API outage.
      if (health) recordFailure("coinglass", error);
      return { ok: false, error };
    }
    consecutive429 = 0;
    stats.ok += 1;
    recordSuccess("coinglass");
    return { ok: true, data: body?.data ?? null };
  } catch (err) {
    stats.failed += 1;
    const error = `${path}: ${err instanceof Error ? err.name : "network error"}`;
    recordFailure("coinglass", error);
    return { ok: false, error };
  } finally {
    inFlight -= 1;
  }
}

export function coinglassGovernorStats() {
  return { ...stats, cooldownMs: Math.max(0, cooldownUntil - Date.now()), minGapMs: MIN_GAP_MS, keys: keys().length };
}

export type UniverseSymbol = {
  /** CoinGlass instrument id on BingX, e.g. "BTC-USDT" (the `symbol` for price history). */
  instrumentId: string;
  base: string;
};

/** Parses /api/futures/supported-exchange-pairs into BingX USDT pairs (USDC excluded: owner rule). */
export function parseSupportedPairs(data: unknown, exchange = EXCHANGE): UniverseSymbol[] {
  const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const rows = Array.isArray(data) ? data : record ? record[exchange] : null;
  if (!Array.isArray(rows)) return [];
  const out = new Map<string, UniverseSymbol>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const instrumentId = String(row.instrument_id ?? row.instrumentId ?? row.symbol ?? "").trim();
    const base = String(row.base_asset ?? row.baseAsset ?? instrumentId.split(/[-_/]/)[0] ?? "").trim().toUpperCase();
    const quote = String(row.quote_asset ?? row.quoteAsset ?? instrumentId.split(/[-_/]/)[1] ?? "").trim().toUpperCase();
    if (!instrumentId || !base || quote !== "USDT") continue;
    out.set(instrumentId, { instrumentId, base });
  }
  return [...out.values()].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
}

export async function getUniverse(): Promise<UniverseSymbol[] | null> {
  const result = await cgRequest("/api/futures/supported-exchange-pairs", { exchange: EXCHANGE });
  if (!result.ok) return null;
  const list = parseSupportedPairs(result.data);
  return list.length ? list : null;
}

/** Rows of /api/futures/price/history → candles (time in s or ms; numbers or strings). */
export function parsePriceRows(data: unknown): Candle[] {
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const rawTime = Number(row.time ?? row.t ?? row.timestamp);
    const t = rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime;
    out.push({
      t,
      o: Number(row.open ?? row.o),
      h: Number(row.high ?? row.h),
      l: Number(row.low ?? row.l),
      c: Number(row.close ?? row.c),
    });
  }
  return normalizeCandles(out);
}

/** BingX OHLC from CoinGlass; `null` when the request failed (never a partial substitute). */
export async function getCandles(
  instrumentId: string, interval: Interval, limit: number, endTime?: number,
): Promise<Candle[] | null> {
  const params: Record<string, string | number> = {
    exchange: EXCHANGE, symbol: instrumentId, interval, limit,
  };
  if (endTime !== undefined) params.end_time = endTime;
  const result = await cgRequest("/api/futures/price/history", params);
  if (!result.ok) return null;
  return parsePriceRows(result.data);
}

/** Deep history by paging backwards with end_time. Stops when CoinGlass has nothing older. */
export async function getCandleHistory(
  instrumentId: string, interval: Interval, bars: number, pageSize = 1000,
): Promise<Candle[] | null> {
  let all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < bars) {
    const page = await getCandles(instrumentId, interval, Math.min(pageSize, bars - all.length + 1), endTime);
    if (page === null) return all.length ? all : null;
    const older = all.length ? page.filter((c) => c.t < all[0].t) : page;
    if (!older.length) break;
    all = normalizeCandles([...older, ...all]);
    endTime = all[0].t - 1;
    if (page.length < 2) break;
  }
  return all.length > bars ? all.slice(all.length - bars) : all;
}
