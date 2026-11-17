/**
 * Owner 2026-11-17 (full rerun of the study, 60 days 18.09–17.11 + live signals 25.10–17.11, current filters):
 *
 * 1) Long only with volume in the block: at least one bright Lucy's VSA bar (aggregated USD futures + spot, O/M/W,
 *    either direction) on the closed 1h candles from the first touch of the block to the entry. Longs with no
 *    bright bar: second half −1.9% a trade, 53% stops; live −3.0%, 60% stops — with one: +5.0% / 15%, +3.7% / 14%.
 *    (First half 18.09–18.10 showed no difference.) No volume data = no long (as the study counted it).
 *
 * 2) Short stop wider by 2 × ATR(14) 1h (the live atrpct_1h). Shorts: first half +1.34 → +1.58% a trade, second
 *    +3.65 → +4.12%, live +4.30 → +4.89%; stops 29 → 22%, 15 → 9%, 14 → 8%. Each remaining stop costs more
 *    (about −10…−11% instead of −7%). Longs: no change (a wider stop did not help them).
 */
import { INTERVAL_MS, type Candle } from "./candles";
import type { SetupSignal } from "./setups";
import { vsaSeries } from "../analysis/candidate-study";
import { fetchVolume1h } from "./short-uptrend";

export const SHORT_STOP_ATR_MULT = 2;

export type ZoneVolume = { pass: boolean; bars: number; bright: number; volume: "ok" | "missing" };

/** Bright bars on the closed 1h candles from the first touch to the entry (pure). */
export function zoneVolume(s: Pick<SetupSignal, "firstTouchAt" | "signalAt">, c1: Candle[], fut: Map<number, number> | null, spot: Map<number, number> | null): ZoneVolume {
  if (!fut) return { pass: false, bars: 0, bright: 0, volume: "missing" };
  const rows = vsaSeries(c1, fut, spot);
  let bars = 0, bright = 0;
  for (let k = 0; k < c1.length; k++) {
    const c = c1[k]!, r = rows[k];
    if (c.t < s.firstTouchAt || c.t + INTERVAL_MS["1h"] > s.signalAt || !r?.has) continue;
    bars += 1;
    if (r.bright) bright += 1;
  }
  return { pass: bright > 0, bars, bright, volume: "ok" };
}

export async function longZoneVolume(symbol: string, s: SetupSignal, c1: Candle[], fetchVol = fetchVolume1h): Promise<ZoneVolume> {
  try {
    const v = await fetchVol(symbol);
    return zoneVolume(s, c1, v.fut, v.spot);
  } catch {
    return { pass: false, bars: 0, bright: 0, volume: "missing" };
  }
}

/** The short's stop moved 2 × ATR % further; the risk recounted. Unknown ATR → the signal as is. */
export function widenShortStop<T extends Pick<SetupSignal, "side" | "entry" | "stop" | "riskPct">>(s: T, atrPct1h: number | null): T & { stopBase: number } {
  if (s.side !== "short" || atrPct1h === null || !Number.isFinite(atrPct1h) || atrPct1h <= 0) return { ...s, stopBase: s.stop };
  const riskPct = s.riskPct + SHORT_STOP_ATR_MULT * atrPct1h;
  return { ...s, stop: s.entry * (1 + riskPct / 100), riskPct: Math.round(riskPct * 1000) / 1000, stopBase: s.stop };
}
