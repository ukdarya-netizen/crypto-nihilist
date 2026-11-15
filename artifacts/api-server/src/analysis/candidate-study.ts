/**
 * Candidate rules on the 60-day history (owner 2026-11-15): the exit study (25.10–13.11, a falling market) found
 * coin-level conditions that separate good trades from stops; this checks the ones measurable on price alone over
 * 60 days and every BingX pair of the backtest (the history has no volume — volume / VPVR rules are not here).
 * One row per trade, as the bot would trade it (one open trade per coin and side; Nihilist's current management,
 * 30m candles): the result and every candidate measure at the signal (closed bars only, no lookahead).
 * The CSV is kept in nh_state (key nhcand:history, gzip) and served by GET /api/nh-study/cand/file.
 */
import { gzipSync } from "node:zlib";
import { pool } from "@workspace/db";
import { INTERVAL_MS, type Candle } from "../engine/candles";
import { MAX_HOLD_MS, entryFilter } from "../engine/config";
import type { SetupSignal } from "../engine/setups";
import { SmcEngine } from "../engine/smc";
import { cgRequest, getUniverse, waitForScanIdle } from "../market/coinglass";
import { cgBase } from "../market/derivatives";
import { logger } from "../lib/logger";
import { allSignals, loadHistory } from "./strategy-report";
import { simulate, variants, type SimTrade } from "./strategy-sim";

const KEY = "nhcand:history";
const SPAN = INTERVAL_MS["30m"];
const H = 3_600_000;
const NOW_MGMT = variants().find((m) => m.id === "now")!;

export const candState = { running: false, startedAt: null as string | null, finishedAt: null as string | null, done: 0, total: 0, rows: 0, error: null as string | null };

// ---------- measures (pure) ----------
const closedBefore = (cs: Candle[], ms: number, at: number) => cs.filter((c) => c.t + ms <= at);
function ema(v: number[], p: number): number[] {
  const k = 2 / (p + 1); const out: number[] = []; let e = v[0]!;
  for (const x of v) { e = x * k + e * (1 - k); out.push(e); }
  return out;
}
function trueRange(cs: Candle[]): number[] {
  return cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1]!.c), Math.abs(c.l - cs[i - 1]!.c))));
}
/** Supertrend(10, 3) direction on the last bar: 1 up, −1 down. */
export function supertrend(cs: Candle[]): number | null {
  if (cs.length < 30) return null;
  const tr = trueRange(cs); const a = 1 / 10; let atr = tr[0]!;
  let ub = 0, lb = 0, dir = 1;
  cs.forEach((c, i) => {
    atr = i === 0 ? tr[0]! : atr * (1 - a) + tr[i]! * a;
    const hl2 = (c.h + c.l) / 2, u = hl2 + 3 * atr, l = hl2 - 3 * atr;
    if (i === 0) { ub = u; lb = l; return; }
    const prev = cs[i - 1]!.c;
    const nub = u < ub || prev > ub ? u : ub, nlb = l > lb || prev < lb ? l : lb;
    dir = c.c > ub ? 1 : c.c < lb ? -1 : dir;
    ub = nub; lb = nlb;
  });
  return dir;
}
/** Number of swings of at least `thr` (fraction) in a close series. */
export function waves(closes: number[], thr = 0.02): number {
  if (closes.length < 2) return 0;
  let n = 0, ext = closes[0]!, dir = 0;
  for (const x of closes.slice(1)) {
    if (dir >= 0 && x > ext) { ext = x; if (dir === 0) dir = 1; }
    if (dir <= 0 && x < ext) { ext = x; if (dir === 0) dir = -1; }
    if (dir === 1 && x < ext * (1 - thr)) { n += 1; dir = -1; ext = x; }
    else if (dir === -1 && x > ext * (1 + thr)) { n += 1; dir = 1; ext = x; }
  }
  return n;
}
function slopePctPerBar(v: number[]): number | null {
  if (v.length < 5) return null;
  const y = v.map(Math.log), n = y.length, xm = (n - 1) / 2, ym = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  y.forEach((yy, i) => { num += (i - xm) * (yy - ym); den += (i - xm) ** 2; });
  return (num / den) * 100;
}
const r4 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "" : String(Math.round(x * 1e4) / 1e4));

export type Measures = Record<string, number | null>;

/**
 * Owner 2026-11-15 («рядом слом структуры наверх, а бот шортит»): the LuxAlgo structure of the coin on every timeframe,
 * as a human reads it on the chart — the same engine as the signals (swing 50 / internal 5), run bar by bar, so a
 * value at a bar never uses a later bar. Per bar: internal and swing trend, the last internal / swing break
 * (direction, CHoCH or BOS, bar index) and the trailing top / bottom (premium / discount range).
 */
export type StructRow = { it: number; st: number; ie: number; ieChoch: number; ieAt: number; se: number; seChoch: number; seAt: number; top: number | null; bot: number | null };
export function structureSeries(cs: Candle[]): StructRow[] {
  const eng = new SmcEngine();
  let ie = 0, ieChoch = 0, ieAt = -1, se = 0, seChoch = 0, seAt = -1;
  return cs.map((c, i) => {
    for (const e of eng.push(c)) {
      if (e.scope === "internal") { ie = e.dir; ieChoch = e.kind === "CHOCH" ? 1 : 0; ieAt = i; }
      else { se = e.dir; seChoch = e.kind === "CHOCH" ? 1 : 0; seAt = i; }
    }
    return { it: eng.internalTrend, st: eng.swingTrend, ie, ieChoch, ieAt, se, seChoch, seAt, top: eng.trailingTop, bot: eng.trailingBottom };
  });
}
/**
 * Owner 2026-11-15: Lucy's VSA exactly as her indicator, on 4h — aggregated USD volume (futures + spot of many
 * exchanges, CoinGlass), Welkin on the total (20 bars with the bar itself, population σ: W > avg+4σ · M > +3σ ·
 * O > +2σ · A > avg · Y ≥ 1.25 × previous · N), a bar under the 120-bar average = N; bright = O / M / W.
 * BUY: bright bar at the lowest low of 20 bars closing above its middle, confirmed by the next bar (close above the
 * middle, no lower low); SELL the mirror. A "buying" bar = bright on a rising candle (her reading of the chart).
 */
const VSA_SPOT = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const VSA_FUT = "Binance,BingX,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Deribit,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,MEXC,OKX,WhiteBIT,dYdX";
const numOf = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(n) ? n : 0; };
async function cgSeries(path: string, params: Record<string, string | number>, cols: [string, string]): Promise<Map<number, number> | null> {
  await waitForScanIdle();
  const res = await cgRequest(path, { ...params, interval: "4h", limit: 700, end_time: Date.now() }, { health: false });
  if (!res.ok || !Array.isArray(res.data)) return null;
  const m = new Map<number, number>();
  for (const r of res.data as Array<Record<string, unknown>>) {
    const t = Number(r.time); if (!Number.isFinite(t)) continue;
    m.set(t < 1e12 ? t * 1000 : t, numOf(r[cols[0]]) + numOf(r[cols[1]]));
  }
  return m;
}
export async function volume4h(symbol: string): Promise<{ fut: Map<number, number> | null; spot: Map<number, number> | null }> {
  const base = cgBase(symbol);
  const fut = await cgSeries("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: VSA_FUT }, ["aggregated_buy_volume_usd", "aggregated_sell_volume_usd"]);
  const spot = await cgSeries("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: VSA_SPOT }, ["agg_taker_buy_vol", "agg_taker_sell_vol"]);
  return { fut, spot };
}
export type VsaRow = { letter: number; bright: boolean; up: boolean; spot: number; total: number; has: boolean; buy: boolean; sell: boolean };
const LETTER = { N: 0, Y: 1, A: 2, O: 3, M: 4, W: 5 } as const;
/** Lucy's VSA per 4h bar; buy / sell = a triangle CONFIRMED on this bar (it marks the previous bar). */
export function vsaSeries(cs: Candle[], fut: Map<number, number> | null, spot: Map<number, number> | null): VsaRow[] {
  const tot = cs.map((c) => (fut?.get(c.t) ?? 0) + (spot?.get(c.t) ?? 0));
  const rows: VsaRow[] = [];
  const brightAt: boolean[] = [];
  for (let i = 0; i < cs.length; i++) {
    const v = tot[i]!;
    let L = 0;
    if (i >= 19) {
      const w = tot.slice(i - 19, i + 1), a = w.reduce((x, y) => x + y, 0) / 20;
      const sd = Math.sqrt(w.reduce((x, y) => x + (y - a) ** 2, 0) / 20);
      L = v > a + 4 * sd ? LETTER.W : v > a + 3 * sd ? LETTER.M : v > a + 2 * sd ? LETTER.O : v > a ? LETTER.A : i > 0 && tot[i - 1]! > 0 && v / tot[i - 1]! >= 1.25 ? LETTER.Y : LETTER.N;
      if (i >= 119) { const la = tot.slice(i - 119, i + 1).reduce((x, y) => x + y, 0) / 120; if (v < la) L = LETTER.N; }
    }
    const c = cs[i]!, bright = L >= LETTER.O;
    brightAt.push(bright);
    let buy = false, sell = false;
    if (i >= 20) {
      const p = cs[i - 1]!, rng = p.h - p.l, pos = rng > 0 ? (p.c - p.l) / rng : 0.5, mid = (p.h + p.l) / 2;
      const lows = cs.slice(i - 20, i).map((x) => x.l), highs = cs.slice(i - 20, i).map((x) => x.h);
      const rawBuy = brightAt[i - 1]! && pos > 0.5 && p.l <= Math.min(...lows);
      const rawSell = brightAt[i - 1]! && pos < 0.5 && p.h >= Math.max(...highs);
      buy = rawBuy && c.c > mid && c.l >= p.l;
      sell = rawSell && c.c < mid && c.h <= p.h;
    }
    rows.push({ letter: L, bright, up: c.c > c.o, spot: spot?.get(c.t) ?? 0, total: tot[i]!, has: (fut?.has(c.t) ?? false) || (spot?.has(c.t) ?? false), buy, sell });
  }
  return rows;
}
/** VSA at the signal on closed 4h bars ("against" = volume pushing against the trade: a short after a bright rising bar). */
export function vsaMeasures(s: SetupSignal, cs: Candle[], rows: VsaRow[]): Measures {
  const d = s.side === "long" ? 1 : -1, m: Measures = {};
  const i = lastClosed(cs, 4 * 3_600_000, s.signalAt);
  if (i < 125 || !rows[i]!.has) return m;
  m.vsa_letter_last = rows[i]!.letter;
  for (const n of [1, 3, 6, 12]) {
    const w = rows.slice(i - n + 1, i + 1);
    m[`vsa_bright_against_${n}`] = w.some((r) => r.bright && (d === 1 ? !r.up : r.up)) ? 1 : 0;
    m[`vsa_bright_with_${n}`] = w.some((r) => r.bright && (d === 1 ? r.up : !r.up)) ? 1 : 0;
  }
  const w3 = rows.slice(i - 2, i + 1);
  m.vsa_active_3 = w3.filter((r) => r.letter > 0).length;
  const t3 = w3.reduce((a, r) => a + r.total, 0);
  m.vsa_spot_share_3 = t3 > 0 ? w3.reduce((a, r) => a + r.spot, 0) / t3 : null;
  const w6 = rows.slice(i - 5, i + 1);
  m.vsa_tri_against_6 = w6.some((r) => (d === 1 ? r.sell : r.buy)) ? 1 : 0;
  m.vsa_tri_with_6 = w6.some((r) => (d === 1 ? r.buy : r.sell)) ? 1 : 0;
  return m;
}

export type StructTf = "30m" | "1h" | "4h" | "1d";
export type Structures = Partial<Record<StructTf, { cs: Candle[]; rows: StructRow[] }>>;
const TF_MS: Record<StructTf, number> = { "30m": 30 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 24 * 3_600_000 };
/** Index of the last bar closed by `at` (−1 if none). */
function lastClosed(cs: Candle[], ms: number, at: number): number {
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid]!.t + ms <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
/** Structure measures ("+" = in the trade's direction; age in bars of that timeframe). */
export function structureMeasures(s: SetupSignal, st: Structures): Measures {
  const d = s.side === "long" ? 1 : -1, m: Measures = {};
  for (const tf of ["30m", "1h", "4h", "1d"] as StructTf[]) {
    const x = st[tf]; if (!x) continue;
    const i = lastClosed(x.cs, TF_MS[tf], s.signalAt); if (i < 0) continue;
    const r = x.rows[i]!;
    m[`smc_int_trend_${tf}`] = r.it === 0 ? null : d * r.it;
    m[`smc_swing_trend_${tf}`] = r.st === 0 ? null : d * r.st;
    m[`smc_int_last_${tf}`] = r.ieAt < 0 ? null : d * r.ie;
    m[`smc_int_last_choch_${tf}`] = r.ieAt < 0 ? null : r.ieChoch;
    m[`smc_int_last_age_${tf}`] = r.ieAt < 0 ? null : i - r.ieAt;
    m[`smc_swing_last_${tf}`] = r.seAt < 0 ? null : d * r.se;
    m[`smc_swing_last_choch_${tf}`] = r.seAt < 0 ? null : r.seChoch;
    m[`smc_swing_last_age_${tf}`] = r.seAt < 0 ? null : i - r.seAt;
    // Premium / discount: 1 = the favourable end (long: bottom of the range, short: top), 0 = the other end.
    if (r.top !== null && r.bot !== null && r.top > r.bot) { const pos = (s.entry - r.bot) / (r.top - r.bot); m[`smc_pd_${tf}`] = d === 1 ? 1 - pos : pos; }
  }
  // The bot's own classic checks at the signal (on the block's timeframe; research only).
  const b = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 1 : 0);
  m.smc_htf_swing_aligned = b(s.smc?.trendSwing); m.smc_htf_int_aligned = b(s.smc?.trendInternal);
  m.smc_htf_discount = b(s.smc?.discount); m.smc_sweep = b(s.smc?.sweep); m.smc_htf_fvg = b(s.smc?.fvg); m.smc_fresh = b(s.smc?.fresh);
  m.htf_is_1d = s.htf === "1d" ? 1 : 0; m.ltf_is_1h = s.ltf === "1h" ? 1 : 0;
  return m;
}
/** Every candidate measure of one signal (d = +1 long / −1 short; "+" = in the trade's direction). */
export function measures(s: SetupSignal, data: Record<"30m" | "1h" | "4h" | "1d", Candle[]>): Measures {
  const d = s.side === "long" ? 1 : -1, at = s.signalAt, m: Measures = {};
  const ltf = data[s.ltf as "30m" | "1h"];
  // break candle (the CHoCH bar)
  const j = ltf.findIndex((c) => c.t === s.barTime);
  if (j >= 2) {
    const b = ltf[j]!, rng = b.h - b.l;
    m.brk_body_share = rng > 0 ? Math.abs(b.c - b.o) / rng : null;
    m.brk_close_pos = rng > 0 ? (d === 1 ? (b.c - b.l) / rng : (b.h - b.c) / rng) : null;   // 1 = closed at the extreme
    m.brk_body_pct = (d * (b.c - b.o) / b.o) * 100;
    let fvg = 0;
    for (let k = Math.max(2, j - 2); k <= j; k++) {
      if (d === 1 && ltf[k]!.l > ltf[k - 2]!.h) fvg = 1;
      if (d === -1 && ltf[k]!.h < ltf[k - 2]!.l) fvg = 1;
    }
    m.brk_fvg = fvg;
  }
  // approach to the block (block created → first touch), 1h closes
  const h1 = closedBefore(data["1h"], H, at);
  const ap = h1.filter((c) => c.t >= s.block.createdAt && c.t < s.firstTouchAt).map((c) => c.c);
  m.ap_bars = ap.length;
  m.ap_waves = ap.length >= 3 ? waves(ap) : null;
  m.ap_move_pct = ap.length >= 2 ? (-d * (ap[ap.length - 1]! / ap[0]! - 1)) * 100 : null;
  // the entry: how far the price already went from the extreme in the block
  m.rebound_pct = (d * (s.entry / s.extreme - 1)) * 100;
  m.entry_out_block_pct = d === 1 ? ((s.entry - s.block.top) / s.entry) * 100 : ((s.block.bottom - s.entry) / s.entry) * 100;
  // the coin's trend
  for (const [tf, cs] of [["1h", h1], ["4h", closedBefore(data["4h"], 4 * H, at)], ["1d", closedBefore(data["1d"], 24 * H, at)]] as const) {
    const st = supertrend(cs.slice(-300)); m[`st_${tf}`] = st === null ? null : d * st;
    const closes = cs.map((c) => c.c);
    if (closes.length >= 60) {
      const e20 = ema(closes, 20), e50 = ema(closes, 50), last = closes[closes.length - 1]!;
      m[`ema20_${tf}`] = (d * (last / e20[e20.length - 1]! - 1)) * 100;
      m[`ema50_${tf}`] = (d * (last / e50[e50.length - 1]! - 1)) * 100;
      if (closes.length >= 210) { const e200 = ema(closes, 200); m[`ema200_${tf}`] = (d * (last / e200[e200.length - 1]! - 1)) * 100; }
      const e12 = ema(closes, 12), e26 = ema(closes, 26), macd = e12.map((x, i) => x - e26[i]!), sig = ema(macd, 9);
      m[`macd_hist_${tf}`] = (d * (macd[macd.length - 1]! - sig[sig.length - 1]!) / last) * 100;
    }
    const sl = slopePctPerBar(closes.slice(-20)); m[`slope20_${tf}`] = sl === null ? null : d * sl;
  }
  const m30 = closedBefore(data["30m"], SPAN, at);
  const c30 = m30.map((c) => c.c);
  if (c30.length >= 60) { const e = ema(c30, 20); m.ema20_30m = (d * (c30[c30.length - 1]! / e[e.length - 1]! - 1)) * 100; }
  const last74 = m30.slice(-74);   // ≈37 h
  if (last74.length >= 20) {
    const lo = Math.min(...last74.map((c) => c.l)), hi = Math.max(...last74.map((c) => c.h));
    const pos = hi > lo ? (s.entry - lo) / (hi - lo) : 0.5;
    m.range37h_far = d === -1 ? 1 - pos : pos;   // short: 1 = entry at the bottom (already fallen); long: 1 = at the top
  }
  const tr1h = trueRange(h1.slice(-15)).slice(1);
  m.atr1h_pct = h1.length > 15 ? (tr1h.reduce((a, b) => a + b, 0) / tr1h.length / h1[h1.length - 1]!.c) * 100 : null;
  m.ret24 = h1.length > 25 ? (d * (h1[h1.length - 1]!.c / h1[h1.length - 25]!.c - 1)) * 100 : null;
  return m;
}

// ---------- the run ----------
const COLS = ["brk_body_share", "brk_close_pos", "brk_body_pct", "brk_fvg", "ap_bars", "ap_waves", "ap_move_pct", "rebound_pct", "entry_out_block_pct",
  "st_1h", "ema20_1h", "ema50_1h", "ema200_1h", "macd_hist_1h", "slope20_1h", "st_4h", "ema20_4h", "ema50_4h", "ema200_4h", "macd_hist_4h", "slope20_4h",
  "st_1d", "ema20_1d", "ema50_1d", "ema200_1d", "macd_hist_1d", "slope20_1d", "ema20_30m", "range37h_far", "atr1h_pct", "ret24",
  ...(["30m", "1h", "4h", "1d"] as const).flatMap((tf) => ["int_trend", "swing_trend", "int_last", "int_last_choch", "int_last_age", "swing_last", "swing_last_choch", "swing_last_age", "pd"].map((k) => `smc_${k}_${tf}`)),
  "smc_htf_swing_aligned", "smc_htf_int_aligned", "smc_htf_discount", "smc_sweep", "smc_htf_fvg", "smc_fresh", "htf_is_1d", "ltf_is_1h",
  "filter_mirror", "block_age_h", "block_size_pct",
  "vsa_letter_last", ...[1, 3, 6, 12].flatMap((n) => [`vsa_bright_against_${n}`, `vsa_bright_with_${n}`]), "vsa_active_3", "vsa_spot_share_3", "vsa_tri_against_6", "vsa_tri_with_6"];
const HEAD = ["symbol", "side", "setup", "signal_at", "entry", "stop", "risk_pct", "long_filter", "closed", "reason", "pnl_pct", "peak_pct", "hold_h", ...COLS].join(",");

export async function candFile(): Promise<{ body: Buffer; rows: number } | null> {
  const r = await pool.query<{ value: { z: string; n: number } }>("SELECT value FROM nh_state WHERE key = $1", [KEY]);
  const v = r.rows[0]?.value;
  if (!v) return null;
  return { body: Buffer.from(v.z, "base64"), rows: v.n };
}

async function run(): Promise<void> {
  const universe = await getUniverse();
  if (!universe) throw new Error("CoinGlass: список монет не получен");
  candState.total = universe.length; candState.done = 0;
  const lines: string[] = [HEAD];
  for (const u of universe) {
    const symbol = u.instrumentId;
    const data = await loadHistory(symbol).catch(() => null);
    if (data) {
      const busy = { long: 0, short: 0 };
      let st: Structures = {};
      try { st = Object.fromEntries((["30m", "1h", "4h", "1d"] as StructTf[]).map((tf) => { const cs = (data as Record<StructTf, Candle[]>)[tf]; return [tf, { cs, rows: structureSeries(cs) }]; })); }
      catch (err) { logger.warn({ err, symbol }, "nihilist: candidate structure failed"); }
      let vsa: VsaRow[] = [];
      try { const v = await volume4h(symbol); vsa = vsaSeries(data["4h"], v.fut, v.spot); }
      catch (err) { logger.warn({ err, symbol }, "nihilist: candidate VSA failed"); }
      for (const s of allSignals(data)) {
        if (s.signalAt < busy[s.side]) continue;   // one open trade per coin and side, as the bot
        const trade: SimTrade = { id: `${symbol}:${s.setup}:${s.signalAt}`, side: s.side, entry: s.entry, stop: s.stop, openedAt: s.signalAt, maxHoldMs: MAX_HOLD_MS[s.htf] };
        const res = simulate(trade, data["30m"], SPAN, NOW_MGMT);
        busy[s.side] = res.closed ? res.closedAt! : Infinity;
        let mm: Measures = {};
        try { mm = { ...measures(s, data as never), ...structureMeasures(s, st), ...(vsa.length ? vsaMeasures(s, data["4h"], vsa) : {}) }; } catch (err) { logger.warn({ err, symbol }, "nihilist: candidate measures failed"); }
        const h1 = data["1h"].filter((c) => c.t + H <= s.signalAt).slice(-15);
        const tr = trueRange(h1).slice(1);
        const atr = h1.length > 2 ? (tr.reduce((a, b) => a + b, 0) / tr.length / h1[h1.length - 1]!.c) * 100 : null;
        const pass = s.side === "short" ? "" : entryFilter({
          side: s.side, riskPct: s.riskPct, entry: s.entry, blockTop: s.block.top, blockBottom: s.block.bottom,
          signalAt: s.signalAt, blockCreatedAt: s.block.createdAt ?? null, blockTime: s.block.time ?? null, atrPct1h: atr,
        }).pass ? "1" : "0";
        // Owner 2026-11-15: the same rules for both sides — the long filter applied to every signal (shorts mirrored),
        // with its parts, so the rejected and the would-be-rejected are all in the file with what happened after.
        const ef = entryFilter({
          side: "long", riskPct: s.riskPct, entry: s.entry, blockTop: s.block.top, blockBottom: s.block.bottom,
          signalAt: s.signalAt, blockCreatedAt: s.block.createdAt ?? null, blockTime: s.block.time ?? null, atrPct1h: atr,
        });
        mm.filter_mirror = ef.pass ? 1 : 0; mm.block_age_h = ef.blockAgeH; mm.block_size_pct = ef.blockSizePct;
        lines.push([symbol, s.side, s.setup, new Date(s.signalAt).toISOString(), s.entry, s.stop, r4(s.riskPct), pass,
          res.closed ? 1 : 0, res.reason ?? "", r4(res.pnlPct), r4(res.peakPct), r4(res.holdH), ...COLS.map((c) => r4(mm[c]))].join(","));
      }
    }
    candState.done += 1;
    candState.rows = lines.length - 1;
    await new Promise((r) => setImmediate(r));
  }
  const z = gzipSync(lines.join("\n") + "\n").toString("base64");
  await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify({ z, n: lines.length - 1 })]);
}

export function startCandStudy(): boolean {
  if (candState.running) return false;
  Object.assign(candState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, done: 0, rows: 0 });
  void run()
    .catch((err) => { candState.error = err instanceof Error ? err.message : String(err); logger.warn({ err }, "nihilist: candidate study failed"); })
    .finally(() => { candState.running = false; candState.finishedAt = new Date().toISOString(); });
  return true;
}
