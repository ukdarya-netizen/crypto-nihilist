/**
 * Exit study (owner 2026-11-13): «отмены на случай откупа или продаж» — was OI on the lower timeframes and the
 * delta ever tested AFTER the entry? (Earlier they were tested only as entry filters.) For every closed signal this
 * exports the 15m path from 150 bars before the entry to the close: BingX candles, aggregated futures taker
 * buy / sell (delta), aggregated spot taker buy / sell, aggregated OI close. The exit rules are simulated offline
 * on this file. Read-only on the database; CoinGlass at the study pace (key shared with CAB and the BTC bot).
 *   path.csv.gz: signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi — 150 bars before the entry to entry + 7 days
 *     (2026-11-14: no longer cut at the real close)
 * Owner 2026-11-13, same run: the volumes of the order block itself, of the approach and of the structure break.
 *   ob.csv.gz: signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell — 1h from 25 days before the block candle
 *     to the signal (4h / 1D are sums of 1h; 120-bar long average on 4h; 2026-11-14: 25 instead of 125 days, the
 *     rows now live in the database);
 *     + oi, funding (OI-weighted), liq_long / liq_short, Binance long % and long/short ratio (crowding, squeeze);
 *   path.csv.gz covers open signals too (up to now); btc.csv.gz: BTC 15m and 1h over the whole period;
 *   meta.csv: id,symbol,side,setup,htf,ltf,opened_at,closed_at,block_time,block_created_at,first_touch_at,last_touch_at,
 *     choch_bar_time,block_top,block_bottom,entry,stop — every signal, open ones included.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { pool } from "@workspace/db";
import { cgRequest, waitForScanIdle } from "../market/coinglass";
import { cgBase } from "../market/derivatives";
import { bingxKlines } from "../market/vsa";
import { logger } from "../lib/logger";

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
  // Owner 2026-11-14: 7 days after the entry whatever the real exit was — other exits (later break-even, exits on
  // buy-backs) and later entries (OTE, retests) run past the real close and need the bars after it.
  const end = Math.min(sig.opened + MAX_AFTER * M15, Date.now());
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


/** 1h from 25 days before the block candle to the signal: order block, approach, break (owner 2026-11-13). */
async function obOf(sig: { id: number; symbol: string; opened: number; blockTime: number | null }): Promise<string[]> {
  if (!sig.blockTime) return [];
  const base = cgBase(sig.symbol);
  const end = Math.floor(sig.opened / H1) * H1;
  const start = Math.floor(sig.blockTime / H1) * H1 - 25 * 24 * H1; // 25 days: 120 bars of 4h before the block
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

// ── Storage (owner 2026-11-14: the night run was lost — the deployment restarted and /tmp went with it). Every
// signal's rows go into nh_state (gzip, key nhstudy:<kind>:<id>), the run resumes where it stopped (also by itself
// after a restart while nhstudy:running is set), and the files are built from the database when downloaded. ──
// "path7": the path to entry + 7 days (2026-11-14); paths stored before that (to the real close) are fetched again.
const KIND = { path: "path7", ob: "ob" } as const;
const KEY = (kind: "path" | "ob", id: number) => `nhstudy:${KIND[kind]}:${id}`;
async function saved(kind: "path" | "ob"): Promise<Set<number>> {
  const r = await pool.query(`SELECT key FROM nh_state WHERE key LIKE $1`, [`nhstudy:${KIND[kind]}:%`]);
  return new Set(r.rows.map((x) => Number(String(x.key).split(":")[2])));
}
async function put(key: string, lines: string[]): Promise<void> {
  const z = gzipSync(lines.join("\n")).toString("base64");
  await pool.query(`INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify({ z, n: lines.length })]);
}
const setRunning = (on: boolean) => pool.query(`INSERT INTO nh_state (key, value, updated_at) VALUES ('nhstudy:running', $1::jsonb, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(on)]);

/** After a restart: carry on if the run was not finished (called once at boot, production only). */
export async function resumeExitStudyIfPending(): Promise<void> {
  const r = await pool.query(`SELECT value FROM nh_state WHERE key = 'nhstudy:running'`).catch(() => null);
  if (r?.rows[0]?.value === true) { say("resuming after a restart"); startExitStudy(); }
}

const SIGNALS_SQL = `
    SELECT id, symbol, side, setup, htf, ltf, status, opened_at, closed_at, block_top, block_bottom, entry, stop,
           details->>'blockTime' AS block_time, details->>'blockCreatedAt' AS block_created_at,
           details->>'firstTouchAt' AS first_touch_at, details->>'lastTouchAt' AS last_touch_at,
           coalesce(details->'chochBar'->>'t', details->'chochBar'->>'time', bar_time::text) AS choch_bar_time
      FROM nh_signals ORDER BY (side = 'short') DESC, opened_at`; // shorts first (owner 2026-11-13)
const META_COLS = ["id", "symbol", "side", "setup", "htf", "ltf", "status", "opened_at", "closed_at", "block_time", "block_created_at", "first_touch_at", "last_touch_at", "choch_bar_time", "block_top", "block_bottom", "entry", "stop"];
const HEADS = {
  "path.csv.gz": "signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi",
  "ob.csv.gz": "signal_id,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi,funding,liq_long,liq_short,ls_long_pct,ls_ratio",
  "btc.csv.gz": "tf,t,o,h,l,c,v,fut_buy,fut_sell,spot_buy,spot_sell,oi",
} as const;

/** A file built from the database now: meta.csv (plain) or one of the .csv.gz. */
export async function exitFile(name: string): Promise<{ body: Buffer; rows: number } | null> {
  if (name === "meta.csv") {
    const all = (await pool.query(SIGNALS_SQL)).rows;
    const out = [META_COLS.join(","), ...all.map((r) => META_COLS.map((c) => csvCell(r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c])).join(","))];
    return { body: Buffer.from(out.join("\n") + "\n"), rows: all.length };
  }
  const head = HEADS[name as keyof typeof HEADS];
  if (!head) return null;
  const prefix = name === "btc.csv.gz" ? "nhstudy:btc" : `nhstudy:${name.startsWith("path") ? KIND.path : KIND.ob}:%`;
  const r = await pool.query(`SELECT value FROM nh_state WHERE key LIKE $1 ORDER BY key`, [prefix]);
  if (!r.rows.length) return null;
  const parts: string[] = [head];
  let rows = 0;
  for (const x of r.rows) {
    const v = x.value as { z: string; n: number };
    if (!v?.n) continue;
    parts.push(gunzipSync(Buffer.from(v.z, "base64")).toString()); rows += v.n;
  }
  return { body: gzipSync(parts.join("\n") + "\n"), rows };
}

/** Removes the stored study rows (after the files are in GitHub). */
export async function clearExitStudy(): Promise<number> {
  const r = await pool.query(`DELETE FROM nh_state WHERE key LIKE 'nhstudy:%'`);
  return r.rowCount ?? 0;
}

async function run(): Promise<void> {
  await setRunning(true);
  const donePath = await saved("path"), doneOb = await saved("ob");
  const all = (await pool.query(SIGNALS_SQL)).rows;
  exitState.total = 2 * all.length + 1;
  exitState.done = all.filter((r) => donePath.has(r.id)).length + all.filter((r) => doneOb.has(r.id)).length;
  say(`signals ${all.length}, saved path ${donePath.size}, ob ${doneOb.size}`);
  // BTC over the whole period, 15m and 1h (owner 2026-11-13: mark the market bounces).
  const haveBtc = (await pool.query(`SELECT 1 FROM nh_state WHERE key = 'nhstudy:btc'`)).rowCount;
  if (!haveBtc && all.length) {
    const first = Math.min(...all.map((r) => new Date(r.opened_at).getTime()));
    const rows: string[] = [];
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
    await put("nhstudy:btc", rows);
    say(`btc: ${rows.length} rows`);
  }
  exitState.done++;
  for (const r of all) {
    const opened = new Date(r.opened_at).getTime();
    if (!doneOb.has(r.id)) {
      await put(KEY("ob", r.id), await obOf({ id: r.id, symbol: r.symbol, opened, blockTime: ms(r.block_time) }));
      exitState.done++;
    }
    // Open signals too (owner 2026-11-13: the open shorts), their path up to now.
    if (!donePath.has(r.id)) {
      await put(KEY("path", r.id), await pathOf({ id: r.id, symbol: r.symbol, opened, closed: r.closed_at ? new Date(r.closed_at).getTime() : Date.now() }));
      exitState.done++;
    }
  }
  await setRunning(false);
  say("done — files are built from the database on download");
}
