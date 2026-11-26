/**
 * Final Nihilist study (owner 2026-11-26): everything the bot writes plus every candle needed, in ONE run inside the
 * published app (the workspace cannot reach the production database). Read-only on the database.
 *   1. db    — every table the bot writes about trades, whole: signals, events, decisions (all reasons), rejected
 *              setups' outcomes, metric snapshots (entry / close), the post-entry trajectory (incl. 72 h after the
 *              close), the trading-bot outbox; nh_state keys (no blobs). Users / Telegram tables are not exported.
 *   2. cand  — the candidate study (analysis/candidate-study.ts) rerun now: 60 days to today, one row per trade as the
 *              bot trades it, every measure (SMC, Lucy's VSA, flow, indicators, VPVR, reaction, BTC, crowd) and the
 *              7-day hourly path; 1h closes of every coin (files history.csv.gz, closes1h.csv.gz).
 *   3. market — 15m for every coin (universe + every coin with a signal or a decision + BTC) from 2026-09-20 to now:
 *              BingX price OHLC, aggregated futures and spot taker buy / sell (Lucy's VSA sources), aggregated OI OHLC,
 *              aggregated liquidations long / short — so every lower-timeframe check (15m / 30m VSA, OI, delta, the
 *              break strength, retest entries, order-block definitions) is done offline without re-downloading.
 * The live scan always goes first (waitForScanIdle); CoinGlass requests go through the app's own governor.
 * Files: process.env.NH_FULL_OUT ?? /tmp/nh-full; served by GET /api/nh-study/full/file/:name.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pool } from "@workspace/db";
import { cgRequest, getUniverse, waitForScanIdle } from "../market/coinglass";
import { cgBase } from "../market/derivatives";
import { logger } from "../lib/logger";
import { VSA_FUT, VSA_SPOT, candState, startCandStudy } from "./candidate-study";

export const FULL_DIR = process.env.NH_FULL_OUT ?? "/tmp/nh-full";
const MKT_FROM = Date.parse("2026-09-20T00:00:00Z");
const STEP = 15 * 60_000;
const PAGE = 1500;

export const fullState = {
  running: false, startedAt: null as string | null, finishedAt: null as string | null,
  stage: "" as "" | "db" | "cand" | "market" | "done", done: 0, total: 0, error: null as string | null,
  log: [] as string[],
};
const note = (s: string) => { fullState.log = [...fullState.log.slice(-40), `${new Date().toISOString()} ${s}`]; logger.info({ s }, "nihilist: full study"); };

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A gzip CSV written line by line (back-pressure respected), renamed into place when complete. */
function gzWriter(name: string) {
  const path = `${FULL_DIR}/${name}`;
  const gz = createGzip();
  const out = createWriteStream(`${path}.part`);
  gz.pipe(out);
  return {
    async line(s: string) { if (!gz.write(s + "\n")) await new Promise((r) => gz.once("drain", r)); },
    async close() {
      await new Promise<void>((resolve, reject) => { out.on("finish", resolve); out.on("error", reject); gz.end(); });
      const { renameSync } = await import("node:fs");
      renameSync(`${path}.part`, path);
    },
  };
}

/** Whole table, paged by its key (no table is loaded into memory at once). */
async function dumpTable(name: string, table: string, key: string[]): Promise<number> {
  const w = gzWriter(`${name}.csv.gz`);
  let cols: string[] | null = null, last: unknown[] | null = null, n = 0;
  for (;;) {
    const cond: string = last ? `WHERE (${key.join(", ")}) > (${key.map((_, i) => `$${i + 1}`).join(", ")})` : "";
    const rows: Record<string, unknown>[] = (await pool.query(`SELECT * FROM ${table} ${cond} ORDER BY ${key.join(", ")} LIMIT 5000`, last ?? [])).rows;
    if (!rows.length) break;
    if (!cols) { cols = Object.keys(rows[0]!); await w.line(cols.join(",")); }
    for (const r of rows) await w.line(cols.map((c) => cell(r[c])).join(","));
    n += rows.length;
    const tail: Record<string, unknown> = rows[rows.length - 1]!;
    last = key.map((k) => tail[k]);
    await new Promise((r) => setImmediate(r));
  }
  if (!cols) await w.line("empty");
  await w.close();
  note(`${table}: ${n} rows`);
  return n;
}

async function stageDb(meta: Record<string, unknown>): Promise<void> {
  fullState.stage = "db";
  const tables: Array<[string, string, string[]]> = [
    ["signals", "nh_signals", ["id"]],
    ["events", "nh_signal_events", ["id"]],
    ["decisions", "nh_decisions", ["id"]],
    ["rejection_outcomes", "nh_rejection_outcomes", ["decision_id"]],
    ["snapshots", "nh_signal_snapshots", ["signal_id"]],
    ["trajectory", "nh_signal_trajectory", ["signal_id", "label"]],
    ["outbox", "nh_trading_outbox", ["id"]],
  ];
  fullState.total = tables.length; fullState.done = 0;
  const counts: Record<string, number> = {};
  for (const [name, table, key] of tables) {
    try { counts[name] = await dumpTable(name, table, key); } catch (err) { counts[name] = -1; note(`${table} FAILED: ${err instanceof Error ? err.message : String(err)}`); }
    fullState.done += 1;
  }
  meta.db_rows = counts;
  const q = async (sql: string) => (await pool.query(sql)).rows;
  meta.state_keys = await q("SELECT key, updated_at, length(value::text) AS bytes FROM nh_state ORDER BY key").catch(() => null);
  meta.decisions_by_reason = await q("SELECT decision, reason, count(*)::int AS n, min(created_at) AS first_at, max(created_at) AS last_at FROM nh_decisions GROUP BY 1, 2 ORDER BY 1, 2").catch(() => null);
  meta.signals_by_status = await q("SELECT live, side, status, close_reason, count(*)::int AS n, min(opened_at) AS first_at, max(opened_at) AS last_at FROM nh_signals GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4").catch(() => null);
  meta.trajectory_labels = await q("SELECT label, count(*)::int AS n FROM nh_signal_trajectory GROUP BY 1 ORDER BY 2 DESC LIMIT 200").catch(() => null);
}

async function stageCand(): Promise<void> {
  fullState.stage = "cand";
  if (!candState.running) startCandStudy();
  note("candidate study started (60 days to today)");
  while (candState.running) {
    fullState.done = candState.done; fullState.total = candState.total;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  fullState.done = candState.done; fullState.total = candState.total;
  if (candState.error) note(`candidate study ERROR: ${candState.error}`);
  else note(`candidate study done: ${candState.rows} rows`);
}

/** One CoinGlass series, 15m, paged backwards from now to MKT_FROM. */
async function series15m(path: string, params: Record<string, string | number>): Promise<{ rows: Map<number, Record<string, unknown>>; error: boolean }> {
  const rows = new Map<number, Record<string, unknown>>();
  let end = Date.now(), error = false;
  for (let page = 0; page < 10; page++) {
    await waitForScanIdle();
    const res = await cgRequest(path, { ...params, interval: "15m", limit: PAGE, end_time: end }, { health: false, priority: false });
    if (!res.ok || !Array.isArray(res.data)) { error = true; break; }
    let oldest = Infinity, added = 0;
    for (const r of res.data as Record<string, unknown>[]) {
      const raw = Number(r.time ?? r.t ?? r.timestamp);
      if (!Number.isFinite(raw)) continue;
      const t = raw < 1e12 ? raw * 1000 : raw;
      if (!rows.has(t)) { rows.set(t, r); added += 1; }
      oldest = Math.min(oldest, t);
    }
    if (!added || oldest <= MKT_FROM || res.data.length < 2) break;
    end = oldest - 1;
  }
  return { rows, error };
}

async function stageMarket(meta: Record<string, unknown>): Promise<void> {
  fullState.stage = "market";
  const dbSyms = (await pool.query("SELECT DISTINCT symbol FROM nh_signals UNION SELECT DISTINCT symbol FROM nh_decisions")).rows.map((r) => String(r.symbol));
  const uni = ((await getUniverse()) ?? []).map((u) => u.instrumentId).filter(Boolean);
  const symbols = [...new Set([...dbSyms, ...uni, "BTC-USDT"])].filter((s) => /-USDT$/.test(s)).sort();
  fullState.total = symbols.length; fullState.done = 0;
  note(`market 15m: ${symbols.length} coins (db ${dbSyms.length}, universe ${uni.length})`);
  const w = gzWriter("market15m.csv.gz");
  await w.line("symbol,t,o,h,l,c,fut_buy_usd,fut_sell_usd,spot_buy_usd,spot_sell_usd,oi_o,oi_h,oi_l,oi_c,liq_long_usd,liq_short_usd");
  const cov = gzWriter("market15m_coverage.csv.gz");
  await cov.line("symbol,series,bars,first,last,error");
  const num = (r: Record<string, unknown> | undefined, k: string) => {
    const v = r?.[k]; if (v === undefined || v === null || v === "") return "";
    const n = Number(v); return Number.isFinite(n) ? String(n) : "";
  };
  for (const sym of symbols) {
    try {
      const base = cgBase(sym);
      const px = await series15m("/api/futures/price/history", { exchange: "BingX", symbol: sym });
      const fut = await series15m("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: VSA_FUT });
      const spot = await series15m("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: VSA_SPOT });
      const oi = await series15m("/api/futures/open-interest/aggregated-history", { symbol: base });
      const liq = await series15m("/api/futures/liquidation/aggregated-history", { symbol: base, exchange_list: VSA_FUT });
      for (const [k, s] of Object.entries({ px, fut, spot, oi, liq })) {
        const ts = [...s.rows.keys()].filter((t) => t >= MKT_FROM).sort((a, b) => a - b);
        await cov.line([sym, k, ts.length, ts.length ? new Date(ts[0]!).toISOString() : "", ts.length ? new Date(ts.at(-1)!).toISOString() : "", s.error].join(","));
      }
      const times = [...px.rows.keys()].filter((t) => t >= MKT_FROM && t % STEP === 0).sort((a, b) => a - b);
      for (const t of times) {
        const p = px.rows.get(t), f = fut.rows.get(t), s = spot.rows.get(t), o = oi.rows.get(t), l = liq.rows.get(t);
        await w.line([sym, t, num(p, "open"), num(p, "high"), num(p, "low"), num(p, "close"),
          num(f, "aggregated_buy_volume_usd"), num(f, "aggregated_sell_volume_usd"), num(s, "agg_taker_buy_vol"), num(s, "agg_taker_sell_vol"),
          num(o, "open"), num(o, "high"), num(o, "low"), num(o, "close"),
          num(l, "aggregated_long_liquidation_usd"), num(l, "aggregated_short_liquidation_usd")].join(","));
      }
    } catch (err) {
      await cov.line([sym, "all", 0, "", "", `"${err instanceof Error ? err.message : String(err)}"`].join(","));
    }
    fullState.done += 1;
    if (fullState.done % 25 === 0) note(`market 15m: ${fullState.done}/${symbols.length}`);
  }
  await w.close(); await cov.close();
  meta.market_coins = symbols.length;
}

async function run(): Promise<void> {
  mkdirSync(FULL_DIR, { recursive: true });
  const meta: Record<string, unknown> = { started_at: new Date().toISOString(), market_from: new Date(MKT_FROM).toISOString() };
  await stageDb(meta);
  writeFileSync(`${FULL_DIR}/meta.json`, JSON.stringify(meta, null, 2));
  await stageCand();
  meta.cand = { rows: candState.rows, error: candState.error, finished_at: candState.finishedAt };
  await stageMarket(meta);
  meta.finished_at = new Date().toISOString();
  writeFileSync(`${FULL_DIR}/meta.json`, JSON.stringify(meta, null, 2));
  fullState.stage = "done";
  note("DONE");
}

export function startFullStudy(): boolean {
  if (fullState.running) return false;
  Object.assign(fullState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, stage: "", done: 0, total: 0, log: [] });
  void run()
    .catch((err) => { fullState.error = err instanceof Error ? err.message : String(err); logger.warn({ err }, "nihilist: full study failed"); })
    .finally(() => { fullState.running = false; fullState.finishedAt = new Date().toISOString(); });
  return true;
}

/** Ready files with their sizes (".part" = still being written). */
export function fullFiles(): Record<string, number> {
  if (!existsSync(FULL_DIR)) return {};
  return Object.fromEntries(readdirSync(FULL_DIR).map((f) => [f, statSync(`${FULL_DIR}/${f}`).size]));
}
