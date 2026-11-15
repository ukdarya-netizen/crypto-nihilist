/**
 * No short into a rising 4h (owner 2026-11-15). A short is not opened when the price on 4h is above the Ichimoku
 * cloud AND either the 4h trend is strong (ADX(14) 4h ≥ 25) or a buyer came in on 1h over the last 6 hours (a bright
 * Lucy's VSA bar — aggregated USD futures + spot volume, O/M/W — on a rising candle).
 *
 * Checked 2026-11-15 on 60 days of the bot's own setups (16.09–15.11, all coins, current filters): September (market
 * rising) −1539% → −383%, 185 of 285 stops cut; October +2556% → +2161%; 1–15 November +733% → +751%. On the live
 * shorts 25.10–13.11: +1085% → +1009%, 28 cut (7 stops, 13 with a peak ≥10%). Longs: the mirror rule only cut good
 * longs — not applied. The indicators and the VSA are the same functions the study used (analysis/candidate-study).
 */
import { cgRequest } from "../market/coinglass";
import { cgBase } from "../market/derivatives";
import { INTERVAL_MS, type Candle } from "./candles";
import type { SetupSignal } from "./setups";
import { VSA_FUT, VSA_SPOT, indicators, numOf, vsa1hMeasures, vsaSeries } from "../analysis/candidate-study";

export const SHORT_UPTREND_ADX_4H = 25;
/** 1h bars of volume fetched for the check: 120-bar long average + the 6 hours + margin. */
const VOL_BARS = 300;

export type ShortUptrend = {
  block: boolean;
  aboveCloud4h: boolean | null;
  adx4h: number | null;
  buying1h6h: boolean | null;
  volume: "ok" | "missing" | "not_needed";
};

/** ADX(14) and the Ichimoku cloud on the closed 4h candles at the signal (a short: −1 = price above the cloud). */
export function trend4h(c4: Candle[], s: Pick<SetupSignal, "signalAt" | "entry">): { aboveCloud: boolean | null; adx: number | null } {
  const closed = c4.filter((c) => c.t + INTERVAL_MS["4h"] <= s.signalAt);
  const m = indicators(closed, -1, "4h", s.entry);
  const cloud = m.ichi_cloud_4h;
  return { aboveCloud: cloud === undefined || cloud === null ? null : cloud === -1, adx: m.adx_4h ?? null };
}

/** The decision itself (pure). */
export function decideShortUptrend(aboveCloud: boolean | null, adx: number | null, buying: boolean | null): boolean {
  return aboveCloud === true && ((adx ?? 0) >= SHORT_UPTREND_ADX_4H || buying === true);
}

type VolMaps = { fut: Map<number, number> | null; spot: Map<number, number> | null };
/** Aggregated 1h USD volume (futures + spot, all exchanges) from CoinGlass — called inside the scan, so no scan wait. */
export async function fetchVolume1h(symbol: string): Promise<VolMaps> {
  const base = cgBase(symbol);
  const get = async (path: string, ex: string, cols: [string, string]) => {
    const res = await cgRequest(path, { symbol: base, exchange_list: ex, interval: "1h", limit: VOL_BARS, end_time: Date.now() }, { health: false, priority: true });
    if (!res.ok || !Array.isArray(res.data)) return null;
    const m = new Map<number, number>();
    for (const r of res.data as Array<Record<string, unknown>>) { const t = Number(r.time); if (Number.isFinite(t)) m.set(t < 1e12 ? t * 1000 : t, numOf(r[cols[0]]) + numOf(r[cols[1]])); }
    return m;
  };
  const fut = await get("/api/futures/aggregated-taker-buy-sell-volume/history", VSA_FUT, ["aggregated_buy_volume_usd", "aggregated_sell_volume_usd"]);
  const spot = fut ? await get("/api/spot/aggregated-cvd/history", VSA_SPOT, ["agg_taker_buy_vol", "agg_taker_sell_vol"]) : null;
  return { fut, spot };
}

/** Full check for a short. Volume is fetched only when it can change the answer (above the cloud, ADX below 25). */
export async function shortUptrend(symbol: string, s: SetupSignal, c4: Candle[], c1: Candle[], fetchVol: (sym: string) => Promise<VolMaps> = fetchVolume1h): Promise<ShortUptrend> {
  const { aboveCloud, adx } = trend4h(c4, s);
  if (aboveCloud !== true || (adx ?? 0) >= SHORT_UPTREND_ADX_4H) {
    return { block: decideShortUptrend(aboveCloud, adx, null), aboveCloud4h: aboveCloud, adx4h: adx, buying1h6h: null, volume: "not_needed" };
  }
  let buying: boolean | null = null, volume: ShortUptrend["volume"] = "missing";
  try {
    const v = await fetchVol(symbol);
    if (v.fut) {
      const m = vsa1hMeasures(s, c1, vsaSeries(c1, v.fut, v.spot));
      if (m.vsa1h_bright_against_6 !== undefined && m.vsa1h_bright_against_6 !== null) { buying = m.vsa1h_bright_against_6 === 1; volume = "ok"; }
    }
  } catch { /* no volume: only the trend part decides */ }
  return { block: decideShortUptrend(aboveCloud, adx, buying), aboveCloud4h: aboveCloud, adx4h: adx, buying1h6h: buying, volume };
}
