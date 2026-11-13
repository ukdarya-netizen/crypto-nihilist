/**
 * Exit study (owner 2026-11-13): «отмены на случай откупа или продаж» — was OI on the lower timeframes and the
 * delta ever tested AFTER the entry? (Earlier they were tested only as entry filters.) For every closed signal this
 * exports the 15m path from 150 bars before the entry to the close: BingX candles, aggregated futures taker
 * buy / sell (delta), aggregated spot taker buy / sell, aggregated OI close. The exit rules are simulated offline
 * on this file. Read-only on the database; CoinGlass at the study pace (key shared with CAB and the BTC bot).
 *   path.csv.gz: signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi
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

async function cg(path: string, params: Record<string, string | number>, cols: string[], end: number, limit: number): Promise<Map<number, Array<number | null>> | null> {
  await sleep(GAP_MS);
  await waitForScanIdle();
  const res = await cgRequest(path, { ...params, interval: "15m", limit, end_time: end }, { health: false });
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

export function startExitStudy(): boolean {
  if (exitState.running) return false;
  Object.assign(exitState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, done: 0, total: 0, error: null, log: [] });
  void run().catch((err) => { exitState.error = String(err); say(`failed: ${String(err)}`); }).finally(() => { exitState.running = false; exitState.finishedAt = new Date().toISOString(); });
  return true;
}

async function run(): Promise<void> {
  mkdirSync(EXIT_DIR, { recursive: true });
  const done = new Set<number>();
  if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").split("\n")) if (l) done.add(JSON.parse(l).id);
  const rows = (await pool.query(`SELECT id, symbol, opened_at, closed_at FROM nh_signals WHERE status = 'closed' AND closed_at IS NOT NULL ORDER BY opened_at`)).rows;
  const todo = rows.filter((r) => !done.has(r.id));
  exitState.total = rows.length; exitState.done = rows.length - todo.length;
  say(`closed signals ${rows.length}, cached ${done.size}`);
  for (const r of todo) {
    const lines = await pathOf({ id: r.id, symbol: r.symbol, opened: new Date(r.opened_at).getTime(), closed: new Date(r.closed_at).getTime() });
    appendFileSync(CACHE, JSON.stringify({ id: r.id, lines }) + "\n");
    exitState.done++;
  }
  const gz = createGzip(); const ws = createWriteStream(`${EXIT_DIR}/path.csv.gz`); gz.pipe(ws);
  gz.write("signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi\n");
  let n = 0;
  for (const l of readFileSync(CACHE, "utf8").split("\n")) {
    if (!l) continue;
    for (const line of JSON.parse(l).lines as string[]) { gz.write(line + "\n"); n++; }
  }
  gz.end(); await new Promise((r) => ws.on("finish", r));
  say(`path.csv.gz: ${n} rows`);
}
