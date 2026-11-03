/**
 * VSA at the signal (owner 2026-11-02: volumes are how bad trades get
 * filtered out). CoinGlass candles carry no volume, so the lower-timeframe
 * bars WITH volume come from the public BingX klines (no key, no CoinGlass
 * budget), one request per signal, only bars closed by the signal.
 * Same features as the research script scripts/src/vsa-adx-features.ts,
 * in the trade direction (shorts mirrored):
 *   vsa_choch_vol_rel   volume of the structure-break bar / avg of 20 before
 *   vsa_ext_vol_rel     volume of the bar that made the extreme in the block / avg20
 *   vsa_ext_close_pos   where that bar closed (long: 1 = at its high — buying into the low)
 *   vsa_ext_spread_atr  its range / ATR14
 *   vsa_max_vol_rel     highest volume / avg20 between the first touch and the break
 *   vsa_test_low_vol    1 = after the extreme a bar came within 0.5 ATR of it on volume < 0.7 × avg20 (VSA test)
 *   vsa_vol_trend       avg volume of the 5 bars before the break / avg20 before them
 *   vsa_no_supply_bars  down bars with spread < 0.7 ATR and volume < avg20 in the window
 *   vsa_window_bars     bars between the first touch and the break
 * Recorded for analysis; no decision uses them yet. Never throws.
 */
import type { Candle } from "../engine/candles";

export type C = Candle & { v: number };
const MS: Record<string, number> = { "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** BingX public klines with volume, bars closed by `end` (oldest first). */
export async function bingxKlines(symbol: string, interval: string, end: number, bars: number): Promise<C[]> {
  const out = new Map<number, C>();
  const span = MS[interval]!;
  let to = end;
  for (let left = bars; left > 0;) {
    const n = Math.min(1000, left);
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&endTime=${to}&limit=${n}`;
    let data: Array<Record<string, string>> | null = null;
    for (let a = 0; a < 3 && !data; a++) {
      try {
        const r = (await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json()) as { code: number; data?: Array<Record<string, string>> };
        if (r.code === 0 && Array.isArray(r.data)) data = r.data;
      } catch { /* retry */ }
      if (!data) await new Promise((r) => setTimeout(r, 800));
    }
    if (!data?.length) break;
    for (const k of data) out.set(Number(k.time), { t: Number(k.time), o: +k.open!, h: +k.high!, l: +k.low!, c: +k.close!, v: +k.volume! });
    left -= data.length;
    to = Math.min(...data.map((k) => Number(k.time))) - 1;
    if (data.length < n) break;
  }
  return [...out.values()].filter((c) => c.t + span <= end).sort((a, b) => a.t - b.t);
}

export const mirror = (cs: C[]): C[] => cs.map((c) => ({ t: c.t, o: -c.o, h: -c.l, l: -c.h, c: -c.c, v: c.v }));
function atrAt(cs: C[], i: number, n = 14): number | null {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(cs[k]!.h - cs[k]!.l, Math.abs(cs[k]!.h - cs[k - 1]!.c), Math.abs(cs[k]!.l - cs[k - 1]!.c));
  return s / n;
}
const avgVol = (cs: C[], end: number, n = 20) => {
  const p = cs.slice(Math.max(0, end - n), end);
  return p.length ? p.reduce((a, c) => a + c.v, 0) / p.length : null;
};
const r3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

/** Pure: features from bars (already mirrored for shorts), k = index of the break bar, w0 = first bar of the window. */
export function vsaFeatures(cs: C[], k: number, w0: number): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  const bar = cs[k]!;
  const av = avgVol(cs, k);
  m.vsa_choch_vol_rel = av ? r3(bar.v / av) : null;
  const win = cs.slice(w0, k);
  m.vsa_window_bars = win.length;
  if (win.length >= 2) {
    let ei = w0;
    for (let i = w0; i < k; i++) if (cs[i]!.l < cs[ei]!.l) ei = i;
    const e = cs[ei]!, ae = atrAt(cs, ei), ave = avgVol(cs, ei);
    if (ae && ave) {
      m.vsa_ext_vol_rel = r3(e.v / ave);
      m.vsa_ext_close_pos = r3(e.h > e.l ? (e.c - e.l) / (e.h - e.l) : null);
      m.vsa_ext_spread_atr = r3((e.h - e.l) / ae);
      let test = 0;
      for (let i = ei + 1; i < k; i++) {
        const c = cs[i]!, avi = avgVol(cs, i);
        if (avi && c.l <= e.l + 0.5 * ae && c.v < 0.7 * avi) { test = 1; break; }
      }
      m.vsa_test_low_vol = test;
    }
    let maxRel = 0, ns = 0;
    for (let i = w0; i < k; i++) {
      const c = cs[i]!, avi = avgVol(cs, i), ai = atrAt(cs, i);
      if (avi) maxRel = Math.max(maxRel, c.v / avi);
      if (avi && ai && c.c < c.o && c.h - c.l < 0.7 * ai && c.v < avi) ns++;
    }
    m.vsa_max_vol_rel = r3(maxRel);
    m.vsa_no_supply_bars = ns;
  }
  if (k >= 25) {
    const v5 = cs.slice(k - 5, k).reduce((x, c) => x + c.v, 0) / 5, v20 = avgVol(cs, k - 5);
    m.vsa_vol_trend = v20 ? r3(v5 / v20) : null;
  }
  return m;
}

/** VSA metrics of one signal (empty object when BingX has no bars). */
export async function vsaMetrics(sig: {
  symbol: string; side: "long" | "short"; ltf: string; signalAt: number; firstTouchAt?: number | null;
}): Promise<Record<string, number | null>> {
  try {
    const span = MS[sig.ltf];
    if (!span) return {};
    const barTime = sig.signalAt - span;
    const startWin = sig.firstTouchAt ?? barTime - 48 * span;
    const bars = Math.min(1400, Math.ceil((sig.signalAt - startWin) / span) + 80);
    let cs = await bingxKlines(sig.symbol, sig.ltf, sig.signalAt, bars);
    if (sig.side === "short") cs = mirror(cs);
    const k = cs.findIndex((c) => c.t === barTime);
    if (k < 25) return {};
    const w0 = Math.max(20, cs.findIndex((c) => c.t >= startWin));
    return vsaFeatures(cs, k, w0);
  } catch {
    return {};
  }
}
