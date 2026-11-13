/**
 * Nihilist final tuning study (owner 2026-11-09): ONE run with everything at the entry of every signal.
 *   trades.csv  — every published signal: how Nihilist closed it (reason, PnL, peak, MFE/MAE, R), the entry filter,
 *                 every metric of its snapshot (OI, L/S, VSA 30m/1h/4h/1D, flow, technical picture, CHoCH bar…)
 *                 and the volume study (Wyckoff, VSA colours, Elliott, ICT) as vs_* columns;
 *   rejects.csv — every setup the entry filter (or another rule) rejected: why, every value of the decision, and what
 *                 the price did afterwards in the block's holding window (+10% first / stop first / none, peak, worst);
 *   both        — MFI and Chaikin computed here at the last closed 30m / 1H / 4H bar before the signal:
 *                 mfi14, cmf20, cho (Chaikin oscillator / 20-bar avg volume), cmf_long (30m 96 = 2 days, 1H 72 = 3 days,
 *                 4H 42 = 7 days), slopes over 12 bars, bull/bear divergences (last 12 bars vs the 36 before), on
 *                 AGGREGATED futures volume (all exchanges, CoinGlass), AGGREGATED spot volume, and — separately and
 *                 marked — BingX's own volume. Missing aggregated data → empty (never filled from BingX).
 *   trajectory_long.csv.gz — every recorded point of longs from the block touch to 24 h after the entry (existing table).
 * Read-only on the database. Runs inside the published app (the workspace cannot reach the production database),
 * started and downloaded through /api/nh-study (token = NIHILIST_TRADING_TOKEN, see routes/final-study.ts).
 * CoinGlass at a gentle pace behind the live scan; resumable within one process: finished signals are kept in
 * mf-cache.jsonl next to the files.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pool } from "@workspace/db";
import { cgRequest, waitForScanIdle } from "../market/coinglass";
import { cgBase } from "../market/derivatives";
import { bingxKlines, type C } from "../market/vsa";

export const STUDY_DIR = process.env.NH_STUDY_OUT ?? "/tmp/nh-final";
const OUT = STUDY_DIR;
// v3 (owner 2026-11-13): + Lucy's VSA before and after the entry, triangles v1 and v2; older caches lack them.
const CACHE = `${OUT}/mf-cache-v3.jsonl`;
export const studyState: { running: boolean; startedAt: string | null; finishedAt: string | null; phase: string; done: number; total: number; error: string | null; log: string[] } =
  { running: false, startedAt: null, finishedAt: null, phase: "idle", done: 0, total: 0, error: null, log: [] };
const say = (m: string) => { studyState.log.push(`${new Date().toISOString()} ${m}`); if (studyState.log.length > 50) studyState.log.shift(); };
// The CoinGlass key is shared with CAB and the BTC bot (owner 2026-11-13): ~24 requests a minute at most.
const GAP_MS = Number(process.env.NH_STUDY_GAP_MS ?? 2500);
const SPOT_EXCHANGES = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const FUTURES_EXCHANGES = "Binance,BingX,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Deribit,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,MEXC,OKX,WhiteBIT,dYdX";
const M30 = 1_800_000, H1 = 3_600_000, H4 = 4 * H1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);

// ---------------- MFI / Chaikin (same formulas as CAB) ----------------
type Bar = { t: number; h: number; l: number; c: number; v: number };
const tp = (c: Bar) => (c.h + c.l + c.c) / 3;
const clv = (c: Bar) => (c.h > c.l ? (c.c - c.l - (c.h - c.c)) / (c.h - c.l) : 0);
function mfiAt(cs: Bar[], i: number, n = 14): number | null {
  if (i < n) return null;
  let pos = 0, neg = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = cs[k]!.v; if (!Number.isFinite(v)) return null;
    const a = tp(cs[k]!), b = tp(cs[k - 1]!);
    if (a > b) pos += a * v; else if (a < b) neg += a * v;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
}
function cmfAt(cs: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let s = 0, v = 0;
  for (let k = i - n + 1; k <= i; k++) { const x = cs[k]!.v; if (!Number.isFinite(x)) return null; s += clv(cs[k]!) * x; v += x; }
  return v > 0 ? s / v : null;
}
function choAt(cs: Bar[], i: number): number | null {
  const from = Math.max(1, i - 150);
  if (i - from < 60) return null;
  let ad = 0, e3: number | null = null, e10: number | null = null;
  for (let k = from; k <= i; k++) {
    const x = cs[k]!.v; if (!Number.isFinite(x)) return null;
    ad += clv(cs[k]!) * x;
    e3 = e3 === null ? ad : e3 + (2 / 4) * (ad - e3);
    e10 = e10 === null ? ad : e10 + (2 / 11) * (ad - e10);
  }
  let v = 0; for (let k = i - 19; k <= i; k++) v += cs[k]!.v;
  return v > 0 && e3 !== null && e10 !== null ? (e3 - e10) / (v / 20) : null;
}
function readings(cs: Bar[], i: number, longN: number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const mfi = (k: number) => mfiAt(cs, k), cmf = (k: number) => cmfAt(cs, k, 20);
  out.mfi14 = mfi(i); out.cmf20 = cmf(i); out.cho = choAt(cs, i); out.cmf_long = cmfAt(cs, i, longN);
  const m12 = mfi(i - 12), c12 = cmf(i - 12);
  out.mfi_slope12 = out.mfi14 != null && m12 != null ? out.mfi14 - m12 : null;
  out.cmf_slope12 = out.cmf20 != null && c12 != null ? out.cmf20 - c12 : null;
  for (const k of ["mfi_bull_div", "mfi_bear_div", "cmf_bull_div", "cmf_bear_div"]) out[k] = null;
  if (i >= 60) {
    const rng = (a: number, b: number, f: (k: number) => number | null, pick: "min" | "max") => {
      let r: number | null = null;
      for (let k = a; k <= b; k++) { const x = f(k); if (x === null) return null; r = r === null ? x : pick === "min" ? Math.min(r, x) : Math.max(r, x); }
      return r;
    };
    const lowR = rng(i - 11, i, (k) => cs[k]!.l, "min")!, lowP = rng(i - 47, i - 12, (k) => cs[k]!.l, "min")!;
    const hiR = rng(i - 11, i, (k) => cs[k]!.h, "max")!, hiP = rng(i - 47, i - 12, (k) => cs[k]!.h, "max")!;
    for (const [name, f] of [["mfi", mfi], ["cmf", cmf]] as const) {
      const minR = rng(i - 11, i, f, "min"), minP = rng(i - 47, i - 12, f, "min");
      const maxR = rng(i - 11, i, f, "max"), maxP = rng(i - 47, i - 12, f, "max");
      out[`${name}_bull_div`] = minR === null || minP === null ? null : lowR < lowP && minR > minP ? 1 : 0;
      out[`${name}_bear_div`] = maxR === null || maxP === null ? null : hiR > hiP && maxR < maxP ? 1 : 0;
    }
  }
  for (const k of Object.keys(out)) out[k] = r4(out[k]!);
  return out;
}

// ---------------- Lucy's VSA (owner's TradingView indicator, one to one) ----------------
// Total = aggregated spot + aggregated futures volume, USD (missing spot counts as 0, as z() in the
// indicator; missing futures = no data). Welkin on the total: SMA(20) and population σ(20) including
// the bar; > avg+4σ W · > avg+3σ M · > avg+2σ O · > avg A · ≥1.25× previous Y · else N; and a bar
// below the long average SMA(120) is N (grey). BUY ▲ = bright bar (O/M/W) that made a lower low and
// closed in the upper half; SELL ▼ = bright bar that made a higher high and closed in the lower half.
const LUCY_LEN = 20, LUCY_LONG = 120;
function lucyLetters(v: number[]): (string | null)[] {
  return v.map((x, i) => {
    if (i < LUCY_LONG - 1 || !Number.isFinite(x)) return null;
    const w = v.slice(i - LUCY_LEN + 1, i + 1), lw = v.slice(i - LUCY_LONG + 1, i + 1);
    if (!w.every(Number.isFinite) || !lw.every(Number.isFinite)) return null;
    const a = w.reduce((s, y) => s + y, 0) / LUCY_LEN;
    const sd = Math.sqrt(w.reduce((s, y) => s + (y - a) ** 2, 0) / LUCY_LEN);
    const la = lw.reduce((s, y) => s + y, 0) / LUCY_LONG;
    const prev = v[i - 1]!;
    const letter = x > a + 4 * sd ? "W" : x > a + 3 * sd ? "M" : x > a + 2 * sd ? "O" : x > a ? "A" : prev > 0 && x / prev >= 1.25 ? "Y" : "N";
    return x < la ? "N" : letter;
  });
}
const bright = (l: string | null) => l === "O" || l === "M" || l === "W";
export function lucyVsa(kl: C[], fut: Map<number, number> | null, spot: Map<number, number> | null, span: number, signalAt: number, tf: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fut || kl.length === 0) { out[`lv_${tf}`] = "missing"; return out; }
  const futV = kl.map((k) => fut.get(k.t) ?? NaN);
  const spotV = kl.map((k) => spot?.get(k.t) ?? 0);
  const agg = futV.map((f, i) => (Number.isFinite(f) ? f + spotV[i]! : NaN));
  const L = lucyLetters(agg), LF = lucyLetters(futV), LS = spot ? lucyLetters(spotV) : kl.map(() => null);
  const mark = kl.map((k, i) => {
    if (i === 0 || !bright(L[i]!)) return null;
    const pos = k.h > k.l ? (k.c - k.l) / (k.h - k.l) : 0.5;
    if (pos >= 0.5 && k.l < kl[i - 1]!.l) return "BUY";
    if (pos <= 0.5 && k.h > kl[i - 1]!.h) return "SELL";
    return null;
  });
  // v2 marks (indicator v2, 2026-11-13): the extreme of the last 20 bars, close strictly beyond the middle, and the
  // next bar confirms (closes beyond the middle of the volume bar, no new extreme). Stored at the CONFIRMING bar —
  // the moment the triangle becomes known — so nothing after the signal leaks into the entry columns.
  const EXT = 20;
  const raw2 = kl.map((k, i) => {
    if (i < EXT - 1 || !bright(L[i]!)) return null;
    const pos = k.h > k.l ? (k.c - k.l) / (k.h - k.l) : 0.5;
    const win = kl.slice(i - EXT + 1, i + 1);
    if (pos > 0.5 && k.l <= Math.min(...win.map((x) => x.l))) return "BUY";
    if (pos < 0.5 && k.h >= Math.max(...win.map((x) => x.h))) return "SELL";
    return null;
  });
  const mark2 = kl.map((k, j) => {
    const r = j > 0 ? raw2[j - 1] : null;
    if (!r) return null;
    const p = kl[j - 1]!, mid = (p.h + p.l) / 2;
    if (r === "BUY" && k.c > mid && k.l >= p.l) return "BUY";
    if (r === "SELL" && k.c < mid && k.h <= p.h) return "SELL";
    return null;
  });
  const last = Math.floor(signalAt / span) * span - span; // last bar closed by the signal
  const i = kl.findIndex((k) => k.t === last);
  if (i < 0 || L[i] === null) { out[`lv_${tf}`] = "missing"; return out; }
  out[`lv_${tf}`] = "ok";
  out[`lv_${tf}_agg`] = L[i]; out[`lv_${tf}_fut`] = LF[i]; out[`lv_${tf}_spot`] = LS[i];
  const count = (from: number, to: number, f: (k: number) => boolean) => { let n = 0; for (let k = Math.max(0, from); k <= Math.min(kl.length - 1, to); k++) if (f(k)) n++; return n; };
  const la = agg.slice(i - LUCY_LONG + 1, i + 1).reduce((s, y) => s + y, 0) / LUCY_LONG;
  out[`lv_${tf}_vs_long`] = r4(la > 0 ? agg[i]! / la : null);
  out[`lv_${tf}_spot_share`] = r4(agg[i]! > 0 ? spotV[i]! / agg[i]! : null);
  for (const n of [6, 24]) {
    out[`lv_${tf}_b${n}_bright`] = count(i - n + 1, i, (k) => bright(L[k]!));
    out[`lv_${tf}_b${n}_grey`] = count(i - n + 1, i, (k) => L[k] === "N");
  }
  const after = kl.length - 1 - i;
  out[`lv_${tf}_after_bars`] = after;
  for (const n of [3, 6, 12, 24]) if (after >= n) out[`lv_${tf}_a${n}_bright`] = count(i + 1, i + n, (k) => bright(L[k]!));
  // v1 = the indicator as it was (lv_), v2 = the fixed triangles (lv2_), same statistics.
  for (const [pre, mk] of [["lv", mark], ["lv2", mark2]] as const) {
    out[`${pre}_${tf}_mark`] = mk[i] ?? "";
    for (const n of [6, 24]) {
      out[`${pre}_${tf}_b${n}_buy`] = count(i - n + 1, i, (k) => mk[k] === "BUY");
      out[`${pre}_${tf}_b${n}_sell`] = count(i - n + 1, i, (k) => mk[k] === "SELL");
    }
    const ago = (m: string) => { for (let k = i; k >= Math.max(0, i - 47); k--) if (mk[k] === m) return i - k; return null; };
    out[`${pre}_${tf}_last_buy_ago`] = ago("BUY"); out[`${pre}_${tf}_last_sell_ago`] = ago("SELL");
    // After the entry (closed bars only): for a short a BUY is volume against it, for a long a SELL.
    for (const n of [3, 6, 12, 24]) {
      if (after < n) continue;
      out[`${pre}_${tf}_a${n}_buy`] = count(i + 1, i + n, (k) => mk[k] === "BUY");
      out[`${pre}_${tf}_a${n}_sell`] = count(i + 1, i + n, (k) => mk[k] === "SELL");
    }
    const first = (m: string) => { for (let k = i + 1; k < kl.length; k++) if (mk[k] === m) return k - i; return null; };
    out[`${pre}_${tf}_first_buy_after`] = first("BUY"); out[`${pre}_${tf}_first_sell_after`] = first("SELL");
    const sym = (k: number) => (mk[k] === "BUY" ? "^" : mk[k] === "SELL" ? "v" : "");
    out[`${pre}_${tf}_seq`] = L.slice(Math.max(0, i - 11), i + 1).map((l, k) => (l ?? "-") + sym(Math.max(0, i - 11) + k)).join("");
    out[`${pre}_${tf}_seq_after`] = L.slice(i + 1, i + 13).map((l, k) => (l ?? "-") + sym(i + 1 + k)).join("");
  }
  return out;
}
function sum4h(m: Map<number, number> | null): Map<number, number> | null {
  if (!m) return null;
  const g = new Map<number, number[]>();
  for (const [t, v] of m) { const k = Math.floor(t / H4) * H4; (g.get(k) ?? g.set(k, []).get(k)!).push(v); }
  const out = new Map<number, number>();
  for (const [t, xs] of g) if (xs.length === 4) out.set(t, xs.reduce((a, b) => a + b, 0));
  return out;
}
function kl4h(k1: C[]): C[] {
  const g = new Map<number, C[]>();
  for (const b of k1) { const k = Math.floor(b.t / H4) * H4; (g.get(k) ?? g.set(k, []).get(k)!).push(b); }
  return [...g.entries()].filter(([, xs]) => xs.length === 4).sort((a, b) => a[0] - b[0])
    .map(([t, xs]) => ({ t, o: xs[0]!.o, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs[3]!.c, v: xs.reduce((s, x) => s + x.v, 0) }));
}

// ---------------- data ----------------
async function cgVolume(path: string, params: Record<string, string | number>, interval: string, end: number, limit: number, buyKey: string, sellKey: string): Promise<Map<number, number> | null> {
  await sleep(GAP_MS);
  await waitForScanIdle(); // the live scan always goes first
  const res = await cgRequest(path, { ...params, interval, limit, end_time: end }, { health: false });
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
  const m = new Map<number, number>();
  for (const r of res.data as Array<Record<string, unknown>>) {
    const t = Number(r.time); const v = (num(r[buyKey]) ?? NaN) + (num(r[sellKey]) ?? NaN);
    if (Number.isFinite(t) && Number.isFinite(v)) m.set(t < 1e12 ? t * 1000 : t, v);
  }
  return m;
}
function toBars(kl: C[], usd: Map<number, number> | null, mode: "agg" | "bingx"): Bar[] {
  return kl.map((k) => {
    if (mode === "bingx") return { t: k.t, h: k.h, l: k.l, c: k.c, v: k.v };
    const u = usd?.get(k.t);
    return { t: k.t, h: k.h, l: k.l, c: k.c, v: u !== undefined && u > 0 && k.c > 0 ? u / k.c : NaN };
  });
}
function to4h(bars1h: Bar[]): Bar[] {
  const g = new Map<number, Bar[]>();
  for (const b of bars1h) { const k = Math.floor(b.t / H4) * H4; (g.get(k) ?? g.set(k, []).get(k)!).push(b); }
  return [...g.entries()].filter(([, xs]) => xs.length === 4).sort((a, b) => a[0] - b[0])
    .map(([t, xs]) => ({ t, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs[3]!.c, v: xs.reduce((s, x) => s + x.v, 0) }));
}

async function moneyFlow(symbol: string, signalAt: number): Promise<Record<string, unknown>> {
  const base = cgBase(symbol);
  const out: Record<string, unknown> = {};
  // Windows run 24 h (30m) / 48 h (1h) past the signal for Lucy's VSA after the entry — same request count;
  // every reading at the entry uses only bars closed by the signal.
  const end30 = Math.min(signalAt + 24 * H1, Date.now()), end1 = Math.min(signalAt + 48 * H1, Date.now());
  const n30 = 320 + Math.ceil((end30 - signalAt) / M30), n1 = 760 + Math.ceil((end1 - signalAt) / H1);
  const [k30, k1] = await Promise.all([bingxKlines(symbol, "30m", end30, n30).catch(() => [] as C[]), bingxKlines(symbol, "1h", end1, n1).catch(() => [] as C[])]);
  const fut30 = await cgVolume("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: FUTURES_EXCHANGES }, "30m", end30, n30, "aggregated_buy_volume_usd", "aggregated_sell_volume_usd");
  const fut1 = await cgVolume("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: FUTURES_EXCHANGES }, "1h", end1, n1, "aggregated_buy_volume_usd", "aggregated_sell_volume_usd");
  const spot30 = await cgVolume("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: SPOT_EXCHANGES }, "30m", end30, n30, "agg_taker_buy_vol", "agg_taker_sell_vol");
  const spot1 = await cgVolume("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: SPOT_EXCHANGES }, "1h", end1, n1, "agg_taker_buy_vol", "agg_taker_sell_vol");
  Object.assign(out, lucyVsa(k30, fut30, spot30, M30, signalAt, "30m"), lucyVsa(k1, fut1, spot1, H1, signalAt, "1h"),
    lucyVsa(kl4h(k1), sum4h(fut1), sum4h(spot1), H4, signalAt, "4h"));
  out.mf_fut = fut1 ? "ok" : "missing"; out.mf_spot = spot1 ? "ok" : "missing";
  const sets: Array<[string, Bar[], number, number]> = [];
  for (const [name, v30, v1, mode] of [["fut", fut30, fut1, "agg"], ["spot", spot30, spot1, "agg"], ["bingx", null, null, "bingx"]] as const) {
    if (mode === "agg" && !v1) continue;
    const b30 = toBars(k30, v30, mode), b1 = toBars(k1, v1, mode);
    sets.push([`${name}_30m`, b30, M30, 96], [`${name}_1h`, b1, H1, 72], [`${name}_4h`, to4h(b1), H4, 42]);
  }
  for (const [name, bars, span, longN] of sets) {
    const last = Math.floor(signalAt / span) * span - span; // last bar closed by the signal
    const i = bars.findIndex((b) => b.t === last);
    if (i < 0) continue;
    for (const [k, v] of Object.entries(readings(bars, i, longN))) out[`mf_${name}_${k}`] = v;
  }
  return out;
}

// ---------------- CSV ----------------
const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function flat(prefix: string, v: unknown, out: Record<string, unknown>) {
  if (v === null || v === undefined) return;
  if (typeof v !== "object" || Array.isArray(v) || v instanceof Date) { out[prefix] = Array.isArray(v) ? JSON.stringify(v) : v; return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) flat(prefix ? `${prefix}_${k}` : k, x, out);
}
function writeCsv(path: string, rows: Array<Record<string, unknown>>, first: string[]) {
  const keys = new Set<string>(); for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const cols = [...first.filter((k) => keys.has(k)), ...[...keys].filter((k) => !first.includes(k)).sort()];
  const ws = createWriteStream(path);
  ws.write(cols.join(",") + "\n");
  for (const r of rows) ws.write(cols.map((k) => cell(r[k])).join(",") + "\n");
  ws.end();
  say(`${path}: ${rows.length} rows, ${cols.length} columns`);
}

async function main() {
  studyState.phase = "reading database";
  mkdirSync(OUT, { recursive: true });
  const cache = new Map<string, Record<string, unknown>>();
  if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").split("\n")) if (l.trim()) { const o = JSON.parse(l); cache.set(o.key, o.mf); }

  const trades = (await pool.query(
    `SELECT s.id, s.symbol, s.side, s.setup, s.htf, s.ltf, s.status, s.close_reason, s.pnl_pct, s.r_multiple, s.mfe_pct, s.mae_pct,
            s.peak_pct, s.risk_pct, s.entry, s.stop, s.exit_price, s.opened_at, s.closed_at, s.live, s.details->'entryFilter' AS entry_filter,
            s.details->'chochBar' AS choch_bar,
            (SELECT n.metrics FROM nh_signal_snapshots n WHERE n.signal_id = s.id ORDER BY n.version DESC LIMIT 1) AS metrics,
            s.details->'volumeStudy' AS volume_study
       FROM nh_signals s ORDER BY s.opened_at`)).rows;
  const rejects = (await pool.query(
    `SELECT o.decision_id, o.symbol, o.setup, o.side, o.reason, o.signal_at, o.window_end, o.entry, o.stop, o.status AS follow_status,
            o.first_event, o.first_at, o.same_candle, o.peak_pct, o.low_pct, d.details
       FROM nh_rejection_outcomes o JOIN nh_decisions d ON d.id = o.decision_id
      WHERE o.status <> 'no_data' ORDER BY o.signal_at`)).rows;
  say(`signals ${trades.length} (live ${trades.filter((t) => t.live).length}), rejections followed ${rejects.length}, cached ${cache.size}`);

  const todo: Array<{ key: string; symbol: string; at: number }> = [
    ...trades.map((t) => ({ key: `s${t.id}`, symbol: t.symbol, at: new Date(t.opened_at).getTime() })),
    ...rejects.map((r) => ({ key: `r${r.decision_id}`, symbol: r.symbol, at: new Date(r.signal_at).getTime() })),
  ].filter((x) => !cache.has(x.key));
  let n = 0;
  studyState.phase = "money flow"; studyState.total = todo.length; studyState.done = 0;
  for (const x of todo) {
    const mf = await moneyFlow(x.symbol, x.at).catch((e) => ({ mf_error: String(e).slice(0, 120) }));
    cache.set(x.key, mf);
    appendFileSync(CACHE, JSON.stringify({ key: x.key, mf }) + "\n");
    studyState.done = ++n;
  }

  studyState.phase = "writing files";
  writeCsv(`${OUT}/trades.csv`, trades.map((t) => {
    const r: Record<string, unknown> = {
      id: t.id, opened_at: t.opened_at, closed_at: t.closed_at, symbol: t.symbol, side: t.side, setup: t.setup, live: t.live,
      status: t.status, close_reason: t.close_reason, pnl_pct: t.pnl_pct, r_multiple: t.r_multiple, mfe_pct: t.mfe_pct, mae_pct: t.mae_pct,
      peak_pct: t.peak_pct, risk_pct: t.risk_pct, entry: t.entry, stop: t.stop, exit_price: t.exit_price,
    };
    flat("ef", t.entry_filter, r); flat("choch", t.choch_bar, r); flat("", t.metrics ?? {}, r); flat("vs", t.volume_study, r);
    Object.assign(r, cache.get(`s${t.id}`) ?? {});
    return r;
  }), ["id", "opened_at", "closed_at", "symbol", "side", "setup", "live", "status", "close_reason", "pnl_pct", "r_multiple", "mfe_pct", "mae_pct", "peak_pct", "risk_pct"]);

  writeCsv(`${OUT}/rejects.csv`, rejects.map((o) => {
    const r: Record<string, unknown> = {
      decision_id: o.decision_id, signal_at: o.signal_at, symbol: o.symbol, setup: o.setup, side: o.side, reason: o.reason,
      entry: o.entry, stop: o.stop, follow_status: o.follow_status, first_event: o.first_event, first_at: o.first_at,
      same_candle: o.same_candle, peak_pct: o.peak_pct, low_pct: o.low_pct, window_end: o.window_end,
    };
    flat("d", o.details, r);
    Object.assign(r, cache.get(`r${o.decision_id}`) ?? {});
    return r;
  }), ["decision_id", "signal_at", "symbol", "setup", "side", "reason", "first_event", "peak_pct", "low_pct", "follow_status"]);

  // Trajectory of longs: block touch → 24 h after the entry (already recorded).
  const traj = (await pool.query(
    `SELECT t.signal_id, s.symbol, s.side, s.setup, s.status, s.close_reason, s.pnl_pct, s.opened_at,
            t.label, t.elapsed_ms, t.at, t.price, t.pct_from_entry, t.reconstructed, t.metrics
       FROM nh_signal_trajectory t JOIN nh_signals s ON s.id = t.signal_id
      WHERE s.live AND t.label NOT LIKE 'be+%' AND t.elapsed_ms <= 86400000
      ORDER BY s.opened_at, t.elapsed_ms`)).rows;
  const keys = new Set<string>(); for (const r of traj) for (const k of Object.keys(r.metrics ?? {})) keys.add(k);
  const base = ["signal_id", "symbol", "side", "setup", "status", "close_reason", "pnl_pct", "opened_at", "label", "elapsed_ms", "at", "price", "pct_from_entry", "reconstructed"];
  const cols = [...base, ...[...keys].sort()];
  const gz = createGzip(); const ws = createWriteStream(`${OUT}/trajectory.csv.gz`); gz.pipe(ws);
  gz.write(cols.join(",") + "\n");
  for (const r of traj) gz.write(cols.map((k) => cell(base.includes(k) ? r[k] : (r.metrics ?? {})[k])).join(",") + "\n");
  gz.end();
  await new Promise((r) => ws.on("finish", r));
  say(`${OUT}/trajectory.csv.gz: ${traj.length} rows`);
}

/** Starts the study in the background (once at a time). */
export function startFinalStudy(): boolean {
  if (studyState.running) return false;
  Object.assign(studyState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, phase: "starting", done: 0, total: 0, error: null });
  void main()
    .then(() => { studyState.phase = "done"; })
    .catch((e) => { studyState.error = String(e).slice(0, 300); studyState.phase = "failed"; })
    .finally(() => { studyState.running = false; studyState.finishedAt = new Date().toISOString(); });
  return true;
}
