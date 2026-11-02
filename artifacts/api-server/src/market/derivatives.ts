/**
 * Derivatives and flow metrics from CoinGlass, as AltBullet records them:
 * open interest, futures taker buy/sell, spot CVD, funding, liquidations and
 * the Binance long/short account ratio. Observation only — no decision uses
 * them (the trading system stays technical). Every history read takes an
 * `asOf` (end_time), so old signals are reconstructed at their own moment.
 * A coin CoinGlass does not cover simply has null metrics.
 */
import { cgRequest, waitForScanIdle } from "./coinglass";

const SPOT_EXCHANGES = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const FUTURES_EXCHANGES = "Binance,BingX,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Deribit,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,MEXC,OKX,WhiteBIT,dYdX";
const ALIAS: Record<string, string> = { USELES: "USELESS", MIRANETWORK: "MIRA" };
const H = 3_600_000;

export const cgBase = (symbol: string) => {
  const base = symbol.replace(/-?USDT$/i, "").toUpperCase();
  return ALIAS[base] ?? base;
};

type Row = Record<string, unknown> & { time: number };
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);

async function history(path: string, params: Record<string, string | number>, asOf: number): Promise<Row[] | null> {
  const res = await cgRequest(path, { ...params, end_time: asOf }, { health: false });
  if (!res.ok || !Array.isArray(res.data)) return null;
  const rows = (res.data as Row[]).map((r) => ({ ...r, time: Number(r.time) }))
    .filter((r) => Number.isFinite(r.time)).sort((a, b) => a.time - b.time);
  // Only bars that had closed by asOf (time is the bar open, 1h bars).
  return rows.filter((r) => r.time + H <= asOf + 60_000);
}

const lastN = <T>(rows: T[], n: number) => rows.slice(Math.max(0, rows.length - n));
const sumOf = (rows: Row[], key: string) => rows.reduce((a, r) => a + (num(r[key]) ?? 0), 0);
const netPct = (buy: number, sell: number) => (buy + sell > 0 ? ((buy - sell) / (buy + sell)) * 100 : null);

/** All metrics at `asOf` (ms). Keys are prefixed "d_". Never throws. */
export async function derivativeMetrics(symbol: string, asOf: number): Promise<Record<string, number | null>> {
  await waitForScanIdle();
  const base = cgBase(symbol);
  const m: Record<string, number | null> = {};
  const [oi, fut, cvd, liq, ratio, funding] = await Promise.all([
    history("/api/futures/open-interest/aggregated-history", { symbol: base, interval: "1h", limit: 30 }, asOf).catch(() => null),
    history("/api/futures/aggregated-taker-buy-sell-volume/history", { symbol: base, interval: "1h", limit: 30, exchange_list: FUTURES_EXCHANGES }, asOf).catch(() => null),
    history("/api/spot/aggregated-cvd/history", { symbol: base, interval: "1h", limit: 30, exchange_list: SPOT_EXCHANGES }, asOf).catch(() => null),
    history("/api/futures/liquidation/aggregated-history", { symbol: base, interval: "1h", limit: 30, exchange_list: FUTURES_EXCHANGES }, asOf).catch(() => null),
    history("/api/futures/global-long-short-account-ratio/history", { exchange: "Binance", symbol: `${base}USDT`, interval: "1h", limit: 6 }, asOf).catch(() => null),
    // Funding history (OI-weighted) supports end_time, unlike the live exchange list.
    history("/api/futures/funding-rate/oi-weight-history", { symbol: base, interval: "1h", limit: 4 }, asOf).catch(() => null),
  ]);
  if (oi?.length) {
    const c = (i: number) => num(oi[oi.length - 1 - i]?.close);
    m.d_oi_usd = r2(c(0));
    m.d_oi_chg1h = r2(pct(c(0), c(1)));
    m.d_oi_chg4h = r2(pct(c(0), c(4)));
    m.d_oi_chg24h = r2(pct(c(0), c(24)));
  }
  if (fut?.length) {
    const buy = "aggregated_buy_volume_usd"; const sell = "aggregated_sell_volume_usd";
    for (const [label, n] of [["1h", 1], ["4h", 4], ["24h", 24]] as const) {
      const part = lastN(fut, n);
      m[`d_fut_taker_net_${label}`] = r2(netPct(sumOf(part, buy), sumOf(part, sell)));
    }
    const vol24 = sumOf(lastN(fut, 24), buy) + sumOf(lastN(fut, 24), sell);
    const vol4 = sumOf(lastN(fut, 4), buy) + sumOf(lastN(fut, 4), sell);
    m.d_fut_vol24h_usd = r2(vol24);
    m.d_fut_vol4h_vs_avg = vol24 > 0 ? r2((vol4 / 4) / (vol24 / 24)) : null;
  }
  if (cvd?.length) {
    const cum = (i: number) => num(cvd[cvd.length - 1 - i]?.cum_vol_delta);
    const now = cum(0);
    m.d_spot_cvd_chg1h = now !== null && cum(1) !== null ? r2(now - cum(1)!) : null;
    m.d_spot_cvd_chg4h = now !== null && cum(4) !== null ? r2(now - cum(4)!) : null;
    m.d_spot_cvd_chg24h = now !== null && cum(24) !== null ? r2(now - cum(24)!) : null;
    for (const [label, n] of [["1h", 1], ["4h", 4], ["24h", 24]] as const) {
      const part = lastN(cvd, n);
      m[`d_spot_taker_net_${label}`] = r2(netPct(sumOf(part, "agg_taker_buy_vol"), sumOf(part, "agg_taker_sell_vol")));
    }
    const spot24 = sumOf(lastN(cvd, 24), "agg_taker_buy_vol") + sumOf(lastN(cvd, 24), "agg_taker_sell_vol");
    m.d_spot_vol24h = r2(spot24);
    m.d_fut_spot_ratio = spot24 > 0 && m.d_fut_vol24h_usd ? r2(m.d_fut_vol24h_usd / spot24) : null;
  }
  if (liq?.length) {
    const L = "aggregated_long_liquidation_usd"; const S = "aggregated_short_liquidation_usd";
    m.d_liq_long_1h = r2(sumOf(lastN(liq, 1), L));
    m.d_liq_short_1h = r2(sumOf(lastN(liq, 1), S));
    m.d_liq_long_24h = r2(sumOf(lastN(liq, 24), L));
    m.d_liq_short_24h = r2(sumOf(lastN(liq, 24), S));
    m.d_liq_long_ratio_1h_24h = m.d_liq_long_24h ? r2(m.d_liq_long_1h! / m.d_liq_long_24h) : null;
  }
  if (ratio?.length) {
    const last = num(ratio[ratio.length - 1].global_account_long_percent);
    const first = num(ratio[0].global_account_long_percent);
    m.d_ls_long_pct = r2(last);
    m.d_ls_long_pct_chg = last !== null && first !== null && ratio.length > 1 ? r2(last - first) : null;
  }
  if (funding?.length) {
    const close = num(funding[funding.length - 1].close);
    m.d_funding_pct = close === null ? null : Math.round(close * 10_000) / 10_000; // % per interval, as CoinGlass reports it
  }
  return m;
}

/** Whether any metric came back (CoinGlass covers the coin). */
export const hasDerivatives = (m: Record<string, unknown>) =>
  Object.entries(m).some(([k, v]) => k.startsWith("d_") && v !== null && v !== undefined);
