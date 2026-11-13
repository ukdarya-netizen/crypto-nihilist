/**
 * Exit study (owner 2026-11-13): «отмены на случай откупа или продаж» — was OI on the lower timeframes and the
 * delta ever tested AFTER the entry? (Earlier they were tested only as entry filters.) For every closed signal this
 * exports the 15m path from 150 bars before the entry to the close: BingX candles, aggregated futures taker
 * buy / sell (delta), aggregated spot taker buy / sell, aggregated OI close. The exit rules are simulated offline
 * on this file. Read-only on the database; CoinGlass at the study pace (key shared with CAB and the BTC bot).
 *   path.csv.gz: signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi
 * Owner 2026-11-13, same run: the volumes of the order block itself, of the approach and of the structure break.
 *   ob.csv.gz: signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell — 1h from 125 days before the block candle
 *     to the signal (4h / 1D are sums of 1h; enough history for the 120-bar long average on 1D);
 *     + oi, funding (OI-weighted), liq_long / liq_short, Binance long % and long/short ratio (crowding, squeeze);
 *   path.csv.gz covers open signals too (up to now); btc.csv.gz: BTC 15m and 1h over the whole period;
 *   meta.csv: id,symbol,side,setup,htf,ltf,opened_at,closed_at,block_time,block_created_at,first_touch_at,last_touch_at,
 *     choch_bar_time,block_top,block_bottom,entry,stop — every signal, open ones included.
 */
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pool } from "@workspace/db";
import { cgRequest, waitForScanIdle } from "../market/coinglass";
import { cgBase } from "../market/derivatives";
import { bingxKlines } from "../market/vsa";
import { logger } from "../lib/logger";

export const EXIT_DIR = process.env.NH_STUDY_DIR ?? "/tmp/nh-final";
const CACHE = `${EXIT_DIR}/exit-path-cache.jsonl`;
const OB_CACHE = `${EXIT_DIR}/exit-ob-cache.jsonl`;
const H1 = 3_600_000;
const M15 = 15 * 60_000;
const BEFORE = 150;
const MAX_AFTER = 7 * 96; // 7 days of 15m bars
const GAP_MS = Number(process.env.NH_STUDY_GAP_MS ?? 2500);
const SPOT = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const FUT = "Binance,BingX,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Deribit,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,MEXC,OKX,WhiteBIT,dYdX";

export const exitState = { running: false, startedAt: null as string | null, finishedAt: null as string | null, done: 0, total: 0, error: null as string | null, log: [] as string[] };
const say = (s: string) => { exitState.log.push(`${new Date().toISOString()} ${s}`); exitState.log = exitState.log.slice(-20); logger.info(`[exit-study] ${s}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

async function cg(path: string, params: Record<string, string | number>, cols: string[], end: number, limit: number, interval = "15m"): Promise<Map<number, Array<number | null>> | null> {
  await sleep(GAP_MS);
  await waitForScanIdle();
  const res = await cgRequest(path, { ...params, interval, limit, end_time: end }, { health: false });
  if (!res.ok || !Array.isArray(res.data)) return null;
  const m = new Map<number, Array<number | null>>();
  for (const r of res.data as Array<Record<string, unknown>>) {
    const t = Number(r.time);
    if (Number.isFinite(t)) m.set(t < 1e12 ? t * 1000 : t, cols.map((c) => num(r[c])));
  }
  return m;
}

async function pathOf(sig: { id: number; symbol: string; opened: number; closed: number }): Promise<string[]> {
  const base = cgBase(sig.symbol);
  const start = Math.floor(sig.opened / M15) * M15 - BEFORE * M15;
  const end = Math.min(sig.closed + 2 * M15, sig.opened + MAX_AFTER * M15, Date.now());
  const limit = Math.min(4500, Math.ceil((end - start) / M15) + 2);
  const kl = await bingxKlines(sig.symbol, "15m", end, limit).catch(() => []);
  const fut = await cg("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: FUT }, ["aggregated_buy_volume_usd", "aggregated_sell_volume_usd"], end, limit);
  const spot = await cg("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: SPOT }, ["agg_taker_buy_vol", "agg_taker_sell_vol"], end, limit);
  const oi = await cg("/api/futures/open-interest/aggregated-history", { symbol: base }, ["close"], end, limit);
  const f = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return kl.filter((k) => k.t >= start).map((k) => {
    const a = fut?.get(k.t), b = spot?.get(k.t), o = oi?.get(k.t);
    return [sig.id, k.t, k.o, k.h, k.l, k.c, k.v, f(a?.[0]), f(a?.[1]), f(b?.[0]), f(b?.[1]), f(o?.[0])].join(",");
  });
}


/** 1h from 125 days before the block candle to the signal: order block, approach, break (owner 2026-11-13). */
async function obOf(sig: { id: number; symbol: string; opened: number; blockTime: number | null }): Promise<string[]> {
  if (!sig.blockTime) return [];
  const base = cgBase(sig.symbol);
  const end = Math.floor(sig.opened / H1) * H1;
  const start = Math.floor(sig.blockTime / H1) * H1 - 125 * 24 * H1;
  const limit = Math.min(4500, Math.ceil((end - start) / H1) + 2);
  const kl = await bingxKlines(sig.symbol, "1h", end, limit).catch(() => []);
  const fut = await cg("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: FUT }, ["aggregated_buy_volume_usd", "aggregated_sell_volume_usd"], end, limit, "1h");
  const spot = await cg("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: SPOT }, ["agg_taker_buy_vol", "agg_taker_sell_vol"], end, limit, "1h");
  // Owner 2026-11-13: crowding and squeeze risk around the block — OI, funding, liquidations, Binance long/short.
  const oi = await cg("/api/futures/open-interest/aggregated-history", { symbol: base }, ["close"], end, limit, "1h");
  const fr = await cg("/api/futures/funding-rate/oi-weight-history", { symbol: base }, ["close"], end, limit, "1h");
  const liq = await cg("/api/futures/liquidation/aggregated-history", { symbol: base, exchange_list: FUT }, ["aggregated_long_liquidation_usd", "aggregated_short_liquidation_usd"], end, limit, "1h");
  const ls = await cg("/api/futures/global-long-short-account-ratio/history", { exchange: "Binance", symbol: `${base}USDT` }, ["global_account_long_percent", "global_account_long_short_ratio"], end, limit, "1h");
  const f = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return kl.filter((k) => k.t >= start).map((k) => {
    const a = fut?.get(k.t), b = spot?.get(k.t), o = oi?.get(k.t), r = fr?.get(k.t), q = liq?.get(k.t), l = ls?.get(k.t);
    return [sig.id, k.t, k.o, k.h, k.l, k.c, k.v, f(a?.[0]), f(a?.[1]), f(b?.[0]), f(b?.[1]), f(o?.[0]), f(r?.[0]), f(q?.[0]), f(q?.[1]), f(l?.[0]), f(l?.[1])].join(",");
  });
}
const ms = (v: unknown) => { const n = num(v); return n === null ? null : n < 1e12 ? n * 1000 : n; };
const csvCell = (v: unknown) => (v === null || v === undefined ? "" : String(v).includes(",") ? `"${String(v)}"` : String(v));

export function startExitStudy(): boolean {
  if (exitState.running) return false;
  Object.assign(exitState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, done: 0, total: 0, error: null, log: [] });
  void run().catch((err) => { exitState.error = String(err); say(`failed: ${String(err)}`); }).finally(() => { exitState.running = false; exitState.finishedAt = new Date().toISOString(); });
  return true;
}

async function run(): Promise<void> {
  mkdirSync(EXIT_DIR, { recursive: true });
  const loaded = (file: string) => { const d = new Set<number>(); if (existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n")) if (l) d.add(JSON.parse(l).id); return d; };
  const donePath = loaded(CACHE), doneOb = loaded(OB_CACHE);
  const all = (await pool.query(`
    SELECT id, symbol, side, setup, htf, ltf, status, opened_at, closed_at, block_top, block_bottom, entry, stop,
           details->>'blockTime' AS block_time, details->>'blockCreatedAt' AS block_created_at,
           details->>'firstTouchAt' AS first_touch_at, details->>'lastTouchAt' AS last_touch_at,
           coalesce(details->'chochBar'->>'t', details->'chochBar'->>'time', bar_time::text) AS choch_bar_time
      FROM nh_signals ORDER BY (side = 'short') DESC, opened_at`)).rows; // shorts first (owner 2026-11-13)
  // meta for every signal (open ones too)
  const cols = ["id", "symbol", "side", "setup", "htf", "ltf", "status", "opened_at", "closed_at", "block_time", "block_created_at", "first_touch_at", "last_touch_at", "choch_bar_time", "block_top", "block_bottom", "entry", "stop"];
  const metaWs = createWriteStream(`${EXIT_DIR}/meta.csv`);
  metaWs.write(cols.join(",") + "\n");
  for (const r of all) metaWs.write(cols.map((c) => csvCell(c.endsWith("_at") && r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c])).join(",") + "\n");
  metaWs.end(); await new Promise((r) => metaWs.on("finish", r));
  exitState.total = 2 * all.length + 1;
  exitState.done = all.filter((r) => donePath.has(r.id)).length + all.filter((r) => doneOb.has(r.id)).length;
  say(`signals ${all.length}, cached path ${donePath.size}, ob ${doneOb.size}`);
  // BTC over the whole period, 15m and 1h (owner 2026-11-13: test reactions to a market reversal).
  if (!existsSync(`${EXIT_DIR}/btc.csv.gz`) && all.length) {
    const first = Math.min(...all.map((r) => new Date(r.opened_at).getTime()));
    const rows: string[] = ["tf,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi"];
    for (const [tf, span] of [["15m", M15], ["1h", H1]] as const) {
      const start = first - 150 * span, end = Date.now();
      const limit = Math.min(4500, Math.ceil((end - start) / span) + 2);
      const kl = await bingxKlines("BTC-USDT", tf, end, limit).catch(() => []);
      const fut = await cg("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: "BTC", exchange_list: FUT }, ["aggregated_buy_volume_usd", "aggregated_sell_volume_usd"], end, limit, tf);
      const spot = await cg("/api/spot/aggregated-cvd/history", { symbol: "BTC", exchange_list: SPOT }, ["agg_taker_buy_vol", "agg_taker_sell_vol"], end, limit, tf);
      const oi = await cg("/api/futures/open-interest/aggregated-history", { symbol: "BTC" }, ["close"], end, limit, tf);
      const f = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
      for (const k of kl) {
        const a = fut?.get(k.t), b = spot?.get(k.t), o = oi?.get(k.t);
        rows.push([tf, k.t, k.o, k.h, k.l, k.c, k.v, f(a?.[0]), f(a?.[1]), f(b?.[0]), f(b?.[1]), f(o?.[0])].join(","));
      }
    }
    const gz = createGzip(); const ws = createWriteStream(`${EXIT_DIR}/btc.csv.gz`); gz.pipe(ws);
    gz.write(rows.join("\n") + "\n"); gz.end(); await new Promise((r) => ws.on("finish", r));
    say(`btc.csv.gz: ${rows.length - 1} rows`);
  }
  exitState.done++;
  for (const r of all) {
    const opened = new Date(r.opened_at).getTime();
    if (!doneOb.has(r.id)) {
      const lines = await obOf({ id: r.id, symbol: r.symbol, opened, blockTime: ms(r.block_time) });
      appendFileSync(OB_CACHE, JSON.stringify({ id: r.id, lines }) + "\n");
      exitState.done++;
    }
    // Open signals too (owner 2026-11-13: the open shorts), their path up to now.
    if (!donePath.has(r.id)) {
      const lines = await pathOf({ id: r.id, symbol: r.symbol, opened, closed: r.closed_at ? new Date(r.closed_at).getTime() : Date.now() });
      appendFileSync(CACHE, JSON.stringify({ id: r.id, lines }) + "\n");
      exitState.done++;
    }
  }
  for (const [cache, out, head] of [
    [CACHE, "path.csv.gz", "signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi"],
    [OB_CACHE, "ob.csv.gz", "signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi,funding,liq_long,liq_short,ls_long_pct,ls_ratio"],
  ] as const) {
    const gz = createGzip(); const ws = createWriteStream(`${EXIT_DIR}/${out}`); gz.pipe(ws);
    gz.write(head + "\n");
    let n = 0;
    for (const l of readFileSync(cache, "utf8").split("\n")) {
      if (!l) continue;
      for (const line of JSON.parse(l).lines as string[]) { gz.write(line + "\n"); n++; }
    }
    gz.end(); await new Promise((r) => ws.on("finish", r));
    say(`${out}: ${n} rows`);
  }
}
