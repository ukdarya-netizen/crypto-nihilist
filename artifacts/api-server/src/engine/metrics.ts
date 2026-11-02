/**
 * Market snapshot of a signal (as AltBullet's indicator snapshots): every
 * technical metric at the moment the signal was known, computed only from
 * bars CLOSED by then. Technical analysis only — no volumes (owner rule).
 * Recorded once per signal, never changed; old signals are reconstructed
 * from stored candles and marked so. Observation only: no decision uses it.
 */
import { INTERVAL_MS, type Candle, type Interval } from "./candles";

export const SNAPSHOT_VERSION = "nh_ta_v1";
type Tf = Exclude<Interval, "5m">;
export type BookLike = Record<Tf, Candle[]>;

export type SignalLike = {
  symbol: string; side: "long" | "short"; htf: string; ltf: string;
  entry: number; stop: number; tp1: number; riskPct: number; rr1: number;
  blockTop: number; blockBottom: number; blockScope: string;
  blockTime?: number | null; blockCreatedAt?: number | null;
  firstTouchAt?: number | null; lastTouchAt?: number | null;
  htfSwingTrend?: number | null; htfInternalTrend?: number | null; ltfAtr?: number | null;
  targetsSource?: string | null;
  confluenceSetups?: string[] | null;
  ob?: { displacementAtr: number | null; breakBars: number | null; heightAtr: number | null; penetrationPct: number | null } | null;
  signalAt: number;
};

export type Metrics = Record<string, number | string | boolean | null>;

const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export function closedAsOf(candles: Candle[], tf: Tf, asOf: number): Candle[] {
  const span = INTERVAL_MS[tf];
  let end = candles.length;
  while (end > 0 && candles[end - 1].t + span > asOf) end--;
  return end === candles.length ? candles : candles.slice(0, end);
}

export function rsi(candles: Candle[], length = 14): number | null {
  if (candles.length <= length) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= length; loss /= length;
  for (let i = length + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    gain = (gain * (length - 1) + Math.max(d, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-d, 0)) / length;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

export function ema(candles: Candle[], length: number): number | null {
  if (candles.length < length) return null;
  const k = 2 / (length + 1);
  let v = candles.slice(0, length).reduce((a, c) => a + c.c, 0) / length;
  for (let i = length; i < candles.length; i++) v = candles[i].c * k + v * (1 - k);
  return v;
}

export function atr(candles: Candle[], length = 14): number | null {
  if (candles.length <= length) return null;
  let v = 0;
  for (let i = 1; i <= length; i++) v += trueRange(candles[i], candles[i - 1]);
  v /= length;
  for (let i = length + 1; i < candles.length; i++) v = (v * (length - 1) + trueRange(candles[i], candles[i - 1])) / length;
  return v;
}

function trueRange(c: Candle, p: Candle): number {
  return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
}

/** % change of the last close vs `bars` bars earlier. */
function change(candles: Candle[], bars: number): number | null {
  if (candles.length <= bars) return null;
  const a = candles[candles.length - 1 - bars].c;
  return ((candles[candles.length - 1].c - a) / a) * 100;
}

/** Position of the last close in the high-low range of the last `bars` bars: 0 = low, 100 = high. */
function rangePos(candles: Candle[], bars: number): number | null {
  if (candles.length < bars) return null;
  const part = candles.slice(-bars);
  const hi = Math.max(...part.map((c) => c.h));
  const lo = Math.min(...part.map((c) => c.l));
  return hi > lo ? ((part[part.length - 1].c - lo) / (hi - lo)) * 100 : null;
}

const distPct = (price: number, ref: number | null) => (ref === null ? null : ((price - ref) / ref) * 100);

/** Technical picture of one market at `asOf` (keys prefixed, e.g. "btc_"). */
export function marketMetrics(book: BookLike, asOf: number, prefix = ""): Metrics {
  const m: Metrics = {};
  const c = (tf: Tf) => closedAsOf(book[tf] ?? [], tf, asOf);
  const s30 = c("30m"); const s1h = c("1h"); const s4h = c("4h"); const s1d = c("1d");
  const last = s30[s30.length - 1]?.c ?? s1h[s1h.length - 1]?.c ?? null;
  m[`${prefix}price`] = last;
  m[`${prefix}chg1h`] = r2(change(s1h, 1));
  m[`${prefix}chg4h`] = r2(change(s1h, 4));
  m[`${prefix}chg24h`] = r2(change(s1h, 24));
  m[`${prefix}chg7d`] = r2(change(s4h, 42));
  m[`${prefix}chg30d`] = r2(change(s1d, 30));
  for (const [tf, series] of [["30m", s30], ["1h", s1h], ["4h", s4h], ["1d", s1d]] as const) {
    m[`${prefix}rsi_${tf}`] = r2(rsi(series));
    const a = atr(series);
    m[`${prefix}atrpct_${tf}`] = last && a !== null ? r2((a / last) * 100) : null;
  }
  if (last !== null) {
    for (const [tf, series] of [["4h", s4h], ["1d", s1d]] as const) {
      const e50 = ema(series, 50); const e200 = ema(series, 200);
      m[`${prefix}ema50dist_${tf}`] = r2(distPct(last, e50));
      m[`${prefix}ema200dist_${tf}`] = r2(distPct(last, e200));
      m[`${prefix}trend_${tf}`] = e50 !== null && e200 !== null ? (e50 > e200 ? "up" : "down") : null;
    }
  }
  m[`${prefix}range24h_pos`] = r2(rangePos(s1h, 24));
  m[`${prefix}range7d_pos`] = r2(rangePos(s4h, 42));
  m[`${prefix}range30d_pos`] = r2(rangePos(s1d, 30));
  return m;
}

/** The full snapshot of a signal: setup geometry + the coin + BTC. */
export function signalSnapshot(sig: SignalLike, coin: BookLike, btc: BookLike | null): Metrics {
  const dir = sig.side === "long" ? 1 : -1;
  const hours = (a?: number | null) => (a ? r2((sig.signalAt - a) / 3_600_000) : null);
  const edge = sig.side === "long" ? sig.blockTop : sig.blockBottom;
  const m: Metrics = {
    side: sig.side, htf: sig.htf, ltf: sig.ltf, block_scope: sig.blockScope,
    targets_source: sig.targetsSource ?? null,
    risk_pct: r2(sig.riskPct), rr1: r2(sig.rr1),
    tp1_pct: r2(((sig.tp1 - sig.entry) / sig.entry) * 100 * dir),
    block_size_pct: r2(((sig.blockTop - sig.blockBottom) / sig.entry) * 100),
    entry_from_block_pct: r2(((sig.entry - edge) / edge) * 100 * dir),
    block_age_h: hours(sig.blockCreatedAt ?? sig.blockTime),
    since_first_touch_h: hours(sig.firstTouchAt),
    since_last_touch_h: hours(sig.lastTouchAt),
    touch_span_h: sig.firstTouchAt && sig.lastTouchAt ? r2((sig.lastTouchAt - sig.firstTouchAt) / 3_600_000) : null,
    ltf_atr_pct: sig.ltfAtr ? r2((sig.ltfAtr / sig.entry) * 100) : null,
    htf_swing_aligned: sig.htfSwingTrend ? sig.htfSwingTrend === dir : null,
    htf_internal_aligned: sig.htfInternalTrend ? sig.htfInternalTrend === dir : null,
    confluence: sig.confluenceSetups?.length ?? null,
    ob_displacement_atr: sig.ob?.displacementAtr ?? null,
    ob_break_bars: sig.ob?.breakBars ?? null,
    ob_height_atr: sig.ob?.heightAtr ?? null,
    ob_penetration_pct: sig.ob?.penetrationPct ?? null,
    hour_utc: new Date(sig.signalAt).getUTCHours(),
    weekday_utc: new Date(sig.signalAt).getUTCDay(),
    ...marketMetrics(coin, sig.signalAt),
  };
  // Trend of the coin in the trade direction (a long "with" the trend = true).
  for (const tf of ["4h", "1d"] as const) {
    const t = m[`trend_${tf}`];
    m[`trend_${tf}_aligned`] = t === null ? null : (t === "up") === (sig.side === "long");
  }
  if (btc && !/^BTC-/.test(sig.symbol)) {
    Object.assign(m, marketMetrics(btc, sig.signalAt, "btc_"));
    const bt = m.btc_trend_4h;
    m.btc_trend_4h_aligned = bt === null ? null : (bt === "up") === (sig.side === "long");
  }
  return m;
}

/** BTC (and the coin) at the moment a trade closed, like AltBullet's close context. */
export function closeContext(coin: BookLike, btc: BookLike | null, closedAt: number): Metrics {
  return {
    ...marketMetrics(coin, closedAt),
    ...(btc ? marketMetrics(btc, closedAt, "btc_") : {}),
  };
}

/** Enough history to reconstruct a snapshot at `asOf`. */
export function coversAsOf(book: BookLike, asOf: number): boolean {
  const s1h = closedAsOf(book["1h"] ?? [], "1h", asOf);
  const s30 = closedAsOf(book["30m"] ?? [], "30m", asOf);
  return s1h.length >= 30 && s30.length >= 20 &&
    asOf - (s30[s30.length - 1].t + INTERVAL_MS["30m"]) <= INTERVAL_MS["1h"];
}
