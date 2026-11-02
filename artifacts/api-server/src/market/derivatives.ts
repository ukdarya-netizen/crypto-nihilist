/**
 * Derivatives metrics from CoinGlass: aggregated open interest and the
 * Binance long/short account ratio (the other flow metrics were dropped by
 * the owner on 2026-11-02). Observation only — no decision uses
 * them (the trading system stays technical). Every history read takes an
 * `asOf` (end_time), so old signals are reconstructed at their own moment.
 * A coin CoinGlass does not cover simply has null metrics.
 */
import { cgRequest, waitForScanIdle } from "./coinglass";

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


/** All metrics at `asOf` (ms). Keys are prefixed "d_". Never throws. */
export async function derivativeMetrics(symbol: string, asOf: number): Promise<Record<string, number | null>> {
  await waitForScanIdle();
  const base = cgBase(symbol);
  const m: Record<string, number | null> = {};
  // Owner 2026-11-02: only OI and the long/short account ratio are requested.
  // Futures/spot taker, spot CVD, liquidations and funding did not separate
  // profits from stops (25.10-02.11) and are no longer fetched.
  const [oi, ratio] = await Promise.all([
    history("/api/futures/open-interest/aggregated-history", { symbol: base, interval: "1h", limit: 30 }, asOf).catch(() => null),
    history("/api/futures/global-long-short-account-ratio/history", { exchange: "Binance", symbol: `${base}USDT`, interval: "1h", limit: 6 }, asOf).catch(() => null),
  ]);
  if (oi?.length) {
    const c = (i: number) => num(oi[oi.length - 1 - i]?.close);
    m.d_oi_usd = r2(c(0));
    m.d_oi_chg1h = r2(pct(c(0), c(1)));
    m.d_oi_chg4h = r2(pct(c(0), c(4)));
    m.d_oi_chg24h = r2(pct(c(0), c(24)));
  }
  if (ratio?.length) {
    const last = num(ratio[ratio.length - 1].global_account_long_percent);
    const first = num(ratio[0].global_account_long_percent);
    m.d_ls_long_pct = r2(last);
    m.d_ls_long_pct_chg = last !== null && first !== null && ratio.length > 1 ? r2(last - first) : null;
  }
  return m;
}

/** Whether any metric came back (CoinGlass covers the coin). */
export const hasDerivatives = (m: Record<string, unknown>) =>
  Object.entries(m).some(([k, v]) => k.startsWith("d_") && v !== null && v !== undefined);
