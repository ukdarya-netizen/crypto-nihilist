/**
 * Volume, open interest and delta around a Nihilist signal (owner 2026-11-03):
 *   1. VSA on 30m, 1h, 4h, 1D at the signal;
 *   2. VSA snapshots after the signal (trajectory points);
 *   3. OI on 15m, 30m, 1h, 4h, 1D at the signal and after it;
 *   4. volume of the order-block candle itself (4h / 1D);
 *   5. how price came into the block (volume trend, spread, pressure bars);
 *   6. OI together with price at the structure break (who moves the price);
 *   7. delta at the touch (futures and spot takers, divergence with price);
 *   8. volume right after the entry.
 * Volume bars: BingX public klines. OI and takers: CoinGlass (aggregated over
 * exchanges). One fetch per signal covers the whole window (touch → close),
 * then every moment is computed from it, so history is rebuilt at its own
 * time. Shorts are mirrored: every metric is "in the trade's direction".
 * Observation only — no decision uses these yet. Never throws.
 */
import { cgRequest, waitForScanIdle } from "./coinglass";
import { cgBase } from "./derivatives";
import { bingxKlines, mirror, vsaFeatures, type C } from "./vsa";

export const FLOW_VERSION = 1;
const SPOT_EXCHANGES = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const FUTURES_EXCHANGES = "Binance,BingX,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Deribit,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,MEXC,OKX,WhiteBIT,dYdX";

export const SPAN: Record<string, number> = { "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
export const OI_TFS = ["15m", "30m", "1h", "4h", "1d"] as const;
export const TAKER_TFS = ["15m", "30m", "1h", "4h"] as const;
export const VSA_TFS = ["30m", "1h", "4h", "1d"] as const;
const KLINE_TFS = ["15m", ...VSA_TFS] as const;

export type Oi = { t: number; c: number };
export type Taker = { t: number; buy: number; sell: number };
export type FlowSeries = {
  side: "long" | "short";
  bars: Record<string, C[]>;      // mirrored for shorts
  oi: Record<string, Oi[]>;
  fut: Record<string, Taker[]>;
  spot: Record<string, Taker[]>;
};
export type FlowSignal = {
  symbol: string; side: "long" | "short"; htf: string; ltf: string; signalAt: number;
  firstTouchAt?: number | null; blockTime?: number | null;
};
type M = Record<string, number | string | null>;

const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const pct = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;

// ---------------- fetching ----------------
async function cgSeries(path: string, params: Record<string, string | number>, interval: string, from: number, to: number): Promise<Array<Record<string, unknown> & { time: number }> | null> {
  const span = SPAN[interval]!;
  const out = new Map<number, Record<string, unknown> & { time: number }>();
  let end = to;
  for (let page = 0; page < 6; page++) {
    await waitForScanIdle(); // the live scan always goes first
    const res = await cgRequest(path, { ...params, interval, limit: 1000, end_time: end }, { health: false });
    if (!res.ok || !Array.isArray(res.data)) return out.size ? [...out.values()].sort((a, b) => a.time - b.time) : null;
    const rows = (res.data as Array<Record<string, unknown>>).map((r) => ({ ...r, time: Number(r.time) })).filter((r) => Number.isFinite(r.time));
    if (!rows.length) break;
    for (const r of rows) out.set(r.time, r);
    const oldest = Math.min(...rows.map((r) => r.time));
    if (oldest <= from || rows.length < 2) break;
    end = oldest - 1;
  }
  return [...out.values()].filter((r) => r.time + span <= to + 60_000).sort((a, b) => a.time - b.time);
}

/** Everything needed for one signal from `from` to `to` (one fetch, all moments computed from it). */
export async function fetchFlowSeries(sig: FlowSignal, to: number): Promise<FlowSeries> {
  const base = cgBase(sig.symbol);
  // Look back far enough for the block candle (1D: 120 bars) and for averages before the touch.
  const touch = sig.firstTouchAt && sig.firstTouchAt < sig.signalAt ? sig.firstTouchAt : sig.signalAt;
  const from = Math.min(touch, sig.blockTime ?? touch) - 40 * SPAN["1d"]!;
  const series: FlowSeries = { side: sig.side, bars: {}, oi: {}, fut: {}, spot: {} };
  const barsWanted = (tf: string) => Math.min(4000, Math.ceil((to - from) / SPAN[tf]!) + 30);
  await Promise.all([
    ...KLINE_TFS.map(async (tf) => {
      const cs = await bingxKlines(sig.symbol, tf, to, barsWanted(tf)).catch(() => [] as C[]);
      series.bars[tf] = sig.side === "short" ? mirror(cs) : cs;
    }),
    ...OI_TFS.map(async (tf) => {
      const lb = Math.max(from, touch - 60 * SPAN[tf]!);
      const rows = await cgSeries("/api/futures/open-interest/aggregated-history", { symbol: base }, tf, lb, to).catch(() => null);
      series.oi[tf] = (rows ?? []).map((r) => ({ t: r.time, c: num(r.close) ?? NaN })).filter((x) => Number.isFinite(x.c));
    }),
    ...TAKER_TFS.map(async (tf) => {
      const lb = Math.max(from, touch - 40 * SPAN[tf]!);
      const [f, s] = await Promise.all([
        cgSeries("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, exchange_list: FUTURES_EXCHANGES }, tf, lb, to).catch(() => null),
        cgSeries("/api/spot/aggregated-cvd/history", { symbol: base, exchange_list: SPOT_EXCHANGES }, tf, lb, to).catch(() => null),
      ]);
      series.fut[tf] = (f ?? []).map((r) => ({ t: r.time, buy: num(r.aggregated_buy_volume_usd) ?? 0, sell: num(r.aggregated_sell_volume_usd) ?? 0 }));
      series.spot[tf] = (s ?? []).map((r) => ({ t: r.time, buy: num(r.agg_taker_buy_vol) ?? 0, sell: num(r.agg_taker_sell_vol) ?? 0 }));
    }),
  ]);
  return series;
}

// ---------------- pure helpers ----------------
/** Index of the last bar closed by `at` (-1 if none). */
export function closedIdx<T extends { t: number }>(rows: T[], tf: string, at: number): number {
  const span = SPAN[tf]!;
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.t + span <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
const avgVol = (cs: C[], end: number, n = 20) => {
  const p = cs.slice(Math.max(0, end - n), end);
  return p.length >= Math.min(n, 5) ? p.reduce((a, c) => a + c.v, 0) / p.length : null;
};
function atrAt(cs: C[], i: number, n = 14): number | null {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(cs[k]!.h - cs[k]!.l, Math.abs(cs[k]!.h - cs[k - 1]!.c), Math.abs(cs[k]!.l - cs[k - 1]!.c));
  return s / n;
}
/** Net taker flow in the trade's direction, % of all taker volume (−100…+100). */
function netIn(rows: Taker[], tf: string, from: number, to: number, dir: number): number | null {
  const span = SPAN[tf]!;
  let buy = 0, sell = 0, n = 0;
  for (const r of rows) if (r.t + span > from && r.t + span <= to) { buy += r.buy; sell += r.sell; n++; } // bars that closed within (from, to]
  return n && buy + sell > 0 ? r3(((buy - sell) / (buy + sell)) * 100 * dir) : null;
}
/** OI quadrant in the trade's direction: who moved the price. */
export function oiQuadrant(priceChgDir: number | null, oiChg: number | null): string | null {
  if (priceChgDir === null || oiChg === null) return null;
  const up = priceChgDir > 0, oiUp = oiChg > 0;
  return up && oiUp ? "with_new_positions" : up ? "on_closing_positions" : oiUp ? "against_new_positions" : "against_on_closing";
}

// ---------------- metrics at the signal ----------------
export function entryFlowMetrics(sig: FlowSignal, s: FlowSeries): M {
  const m: M = { flow_v: FLOW_VERSION };
  const dir = sig.side === "long" ? 1 : -1;
  const at = sig.signalAt;
  const touch = sig.firstTouchAt && sig.firstTouchAt < at ? sig.firstTouchAt : null;

  // 1. VSA on 30m, 1h, 4h, 1D (window: from the touch; the last bar closed by the signal plays the break bar).
  for (const tf of VSA_TFS) {
    const cs = s.bars[tf] ?? [];
    const k = closedIdx(cs, tf, at);
    if (k < 25) continue;
    const w0 = touch ? Math.max(20, cs.findIndex((c) => c.t + SPAN[tf]! > touch)) : Math.max(20, k - 10);
    const f = vsaFeatures(cs, k, w0 >= 0 && w0 <= k ? w0 : Math.max(20, k - 10));
    for (const [key, v] of Object.entries(f)) m[`vsa${tf}_${key.replace(/^vsa_/, "")}`] = v;
  }

  // 4. Volume of the order-block candle on its own timeframe (and the bar after it).
  const htf = sig.htf === "1d" ? "1d" : "4h";
  const hb = s.bars[htf] ?? [];
  if (sig.blockTime) {
    const i = hb.findIndex((c) => c.t === sig.blockTime);
    if (i >= 20) {
      const av = avgVol(hb, i);
      const prev = hb.slice(Math.max(0, i - 100), i).map((c) => c.v);
      m.ob_vol_rel = av ? r3(hb[i]!.v / av) : null;
      m.ob_vol_rank = prev.length ? r3((prev.filter((v) => v < hb[i]!.v).length / prev.length) * 100) : null;
      m.ob_next_vol_rel = av && hb[i + 1] && hb[i + 1]!.t + SPAN[htf]! <= at ? r3(hb[i + 1]!.v / av) : null;
      const a = atrAt(hb, i);
      m.ob_spread_atr = a ? r3((hb[i]!.h - hb[i]!.l) / a) : null;
    }
  }

  // 5. How price came into the block: the bars before the first touch.
  if (touch) {
    for (const tf of ["30m", "1h", "4h"] as const) {
      const cs = s.bars[tf] ?? [];
      const k = closedIdx(cs, tf, touch);
      if (k < 30) continue;
      const v5 = cs.slice(k - 4, k + 1).reduce((a, c) => a + c.v, 0) / 5;
      const v20 = avgVol(cs, k - 4);
      m[`app${tf}_vol_trend`] = v20 ? r3(v5 / v20) : null;
      let spread = 0, press = 0, cnt = 0;
      for (let i = k - 4; i <= k; i++) { const a = atrAt(cs, i); if (a) { spread += (cs[i]!.h - cs[i]!.l) / a; cnt++; } }
      m[`app${tf}_spread_atr`] = cnt ? r3(spread / cnt) : null;
      for (let i = k - 9; i <= k; i++) {
        const c = cs[i]!, a = atrAt(cs, i), av = avgVol(cs, i);
        // Toward the block (long: down bars; shorts are mirrored) on high volume and a wide spread.
        if (a && av && c.c < c.o && c.v > 1.5 * av && c.h - c.l > 1.2 * a) press++;
      }
      m[`app${tf}_press_bars`] = press;
      const move = pct(cs[k]!.c, cs[k - 10]!.c);
      m[`app${tf}_move10`] = r3(move);
    }
  }

  // 3. OI on every timeframe at the signal; 6. OI with price at the break and from the touch.
  const p30 = s.bars["30m"] ?? [];
  for (const tf of OI_TFS) {
    const oi = s.oi[tf] ?? [];
    const i = closedIdx(oi, tf, at);
    if (i < 1) continue;
    m[`oi${tf}_chg1`] = r3(pct(oi[i]!.c, oi[i - 1]!.c));
    if (i >= 4) m[`oi${tf}_chg4`] = r3(pct(oi[i]!.c, oi[i - 4]!.c));
    if (tf === "15m" || tf === "30m" || tf === "1h") {
      // The break: the last bar of this timeframe before the signal.
      const bars = s.bars[tf] ?? [];
      const bi = closedIdx(bars, tf, at);
      const priceChg = bi >= 1 ? pct(bars[bi]!.c, bars[bi - 1]!.c) : null; // mirrored: in the trade's direction
      m[`oi_quad_break_${tf}`] = oiQuadrant(priceChg, num(m[`oi${tf}_chg1`]));
      if (touch) {
        const j = closedIdx(oi, tf, touch);
        if (j >= 0 && j < i) {
          m[`oi${tf}_chg_touch`] = r3(pct(oi[i]!.c, oi[j]!.c));
          const pt = closedIdx(p30, "30m", touch), pa = closedIdx(p30, "30m", at);
          const pc = pt >= 0 && pa > pt ? pct(p30[pa]!.c, p30[pt]!.c) : null;
          m[`oi_quad_touch_${tf}`] = oiQuadrant(pc, num(m[`oi${tf}_chg_touch`]));
        }
      }
    }
  }

  // 7. Delta at the touch: takers from the touch to the signal and on the break bar; divergence with price.
  const dtf = (s.fut["15m"]?.length ? "15m" : "30m") as "15m" | "30m";
  const ltf = sig.ltf === "1h" ? "1h" : "30m";
  m.dlt_tf = dtf;
  if (touch) {
    m.dlt_fut_touch_net = netIn(s.fut[dtf] ?? [], dtf, touch, at, dir);
    m.dlt_spot_touch_net = netIn(s.spot[dtf] ?? [], dtf, touch, at, dir);
    const f = num(m.dlt_fut_touch_net), sp = num(m.dlt_spot_touch_net);
    m.dlt_spot_minus_fut_touch = f !== null && sp !== null ? r3(sp - f) : null;
    for (const [name, rows] of [["fut", s.fut[dtf] ?? []], ["spot", s.spot[dtf] ?? []]] as const) {
      m[`dlt_div_${name}`] = deltaDivergence(p30, rows, dtf, touch, at, dir);
    }
  }
  m.dlt_fut_break_net = netIn(s.fut[ltf] ?? [], ltf, at - SPAN[ltf]!, at, dir);
  m.dlt_spot_break_net = netIn(s.spot[ltf] ?? [], ltf, at - SPAN[ltf]!, at, dir);
  m.dlt_fut_4h_net = netIn(s.fut["1h"] ?? [], "1h", at - 4 * SPAN["1h"]!, at, dir);
  m.dlt_spot_4h_net = netIn(s.spot["1h"] ?? [], "1h", at - 4 * SPAN["1h"]!, at, dir);
  return m;
}

/**
 * Price vs delta after the touch (mirrored price, delta in the trade's direction):
 * "divergence" = price made a new extreme against the trade after the touch but
 * the cumulative delta did not (sellers absorbed); "confirmed" = both went
 * against; "no_new_extreme" = price did not go beyond the touch bar.
 */
export function deltaDivergence(p30: C[], rows: Taker[], tf: string, touch: number, at: number, dir: number): string | null {
  const t0 = closedIdx(p30, "30m", touch + SPAN["30m"]!), t1 = closedIdx(p30, "30m", at);
  if (t0 < 0 || t1 <= t0 || !rows.length) return null;
  let lowI = t0;
  for (let i = t0 + 1; i <= t1; i++) if (p30[i]!.l < p30[lowI]!.l) lowI = i;
  if (lowI === t0) return "no_new_extreme";
  const cumAt = (end: number) => {
    let c = 0;
    for (const r of rows) if (r.t >= touch && r.t + SPAN[tf]! <= end) c += (r.buy - r.sell) * dir;
    return c;
  };
  const atTouch = cumAt(p30[t0]!.t + SPAN["30m"]!);
  const atLow = cumAt(p30[lowI]!.t + SPAN["30m"]!);
  return atLow > atTouch ? "divergence" : "confirmed";
}

// ---------------- metrics at a moment after the signal ----------------
/** 2. VSA snapshot, 3. OI on every timeframe, 8. volume and delta since the entry — at moment `at`. */
export function pointFlowMetrics(sig: FlowSignal, s: FlowSeries, at: number): M {
  const m: M = { flow_v: FLOW_VERSION };
  const dir = sig.side === "long" ? 1 : -1;
  for (const tf of ["30m", "1h", "4h"] as const) {
    const cs = s.bars[tf] ?? [];
    const k = closedIdx(cs, tf, at);
    if (k < 21) continue;
    const c = cs[k]!, av = avgVol(cs, k), a = atrAt(cs, k);
    m[`v${tf}_last_vol_rel`] = av ? r3(c.v / av) : null;
    m[`v${tf}_last_spread_atr`] = a ? r3((c.h - c.l) / a) : null;
    m[`v${tf}_last_close_pos`] = c.h > c.l ? r3((c.c - c.l) / (c.h - c.l)) : null;
    m[`v${tf}_last_dir`] = c.c > c.o ? 1 : c.c < c.o ? -1 : 0;
  }
  for (const tf of OI_TFS) {
    const oi = s.oi[tf] ?? [];
    const i = closedIdx(oi, tf, at);
    if (i < 1) continue;
    m[`oi${tf}_chg1`] = r3(pct(oi[i]!.c, oi[i - 1]!.c));
    if (i >= 4) m[`oi${tf}_chg4`] = r3(pct(oi[i]!.c, oi[i - 4]!.c));
  }
  // Since the entry.
  const oi15 = s.oi["15m"]?.length ? s.oi["15m"]! : s.oi["30m"] ?? [];
  const otf = s.oi["15m"]?.length ? "15m" : "30m";
  const e = closedIdx(oi15, otf, sig.signalAt), n = closedIdx(oi15, otf, at);
  m.oi_since_entry = e >= 0 && n > e ? r3(pct(oi15[n]!.c, oi15[e]!.c)) : null;
  const dtf = s.fut["15m"]?.length ? "15m" : "30m";
  m.dlt_fut_since_entry = netIn(s.fut[dtf] ?? [], dtf, sig.signalAt, at, dir);
  m.dlt_spot_since_entry = netIn(s.spot[dtf] ?? [], dtf, sig.signalAt, at, dir);
  const cs = s.bars["30m"] ?? [];
  const k0 = closedIdx(cs, "30m", sig.signalAt), k1 = closedIdx(cs, "30m", at);
  if (k0 >= 20 && k1 > k0) {
    const av = avgVol(cs, k0 + 1);
    const after = cs.slice(k0 + 1, k1 + 1);
    const total = after.reduce((x, c) => x + c.v, 0);
    const against = after.filter((c) => c.c < c.o); // mirrored: against the trade
    m.post_bars = after.length;
    m.post_vol_rel = av ? r3(total / after.length / av) : null;
    m.post_against_share = total > 0 ? r3(against.reduce((x, c) => x + c.v, 0) / total) : null;
    m.post_max_against_vol_rel = av && against.length ? r3(Math.max(...against.map((c) => c.v)) / av) : 0;
    m.post_move = r3(pct(cs[k1]!.c, cs[k0]!.c));
  }
  return m;
}

/** Early post-entry keys stored with the entry snapshot (for analysis next to the entry metrics). */
export const POST_MARKS: Array<[string, number]> = [["post1h", 3_600_000], ["post2h", 7_200_000], ["post4h", 14_400_000]];
const POST_KEYS = ["post_vol_rel", "post_against_share", "post_max_against_vol_rel", "post_move", "oi_since_entry", "dlt_fut_since_entry", "dlt_spot_since_entry"];
export function postEntryMetrics(sig: FlowSignal, s: FlowSeries, endAt: number): M {
  const m: M = {};
  for (const [label, off] of POST_MARKS) {
    if (sig.signalAt + off > endAt) continue;
    const p = pointFlowMetrics(sig, s, sig.signalAt + off);
    for (const k of POST_KEYS) m[`${label}_${k.replace(/^post_/, "")}`] = p[k] ?? null;
  }
  return m;
}
