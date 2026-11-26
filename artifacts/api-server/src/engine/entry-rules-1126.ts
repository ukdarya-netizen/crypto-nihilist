import type { Candle } from "./candles";

/**
 * Owner 2026-11-26 (final study: every live trade, decision and rejected setup since 25.10 + the 60-day rerun to
 * 26.11 with 15m data, a falling market and the 21–23.11 bounce): a long only on a strong structure break — the
 * range (high − low) of the LTF break (CHoCH) candle at least 3% of its open.
 *   Live longs since 09.11: break ≥3% — 19 trades +46%, 4 stops; <3% — 20 trades −83%, 13 stops (both in the fall
 *   and in the bounce). 60-day rerun, current long filter: average +2.7% vs +2.2% a trade, stops 18% vs 25%, but the
 *   total +62% vs +164% (late Sep – Oct small-break longs earned). Unknown candle = no long.
 */
export const LONG_MIN_BREAK_RANGE_PCT = 3;

export type BreakStrength = { pass: boolean; rangePct: number | null };

/** Pure: the break candle's range % (chochBar.rangePct) against the threshold. */
export function longBreakStrength(chochBar: Record<string, number | null> | null): BreakStrength {
  const v = chochBar?.rangePct;
  const rangePct = typeof v === "number" && Number.isFinite(v) ? v : null;
  return { pass: rangePct !== null && rangePct >= LONG_MIN_BREAK_RANGE_PCT, rangePct };
}

/**
 * Owner 2026-11-26 (same study, shorts in a rising market): no short on a coin whose OWN daily trend is up — +DI(14)
 * above −DI(14) on the coin's closed 1D candles (not BTC's). Live shorts since 09.11 (229 closed): it would cut 40 —
 * about 1% of the profit (+9% of +1124%) and 13 of 31 stop losses; 60-day rerun: 35% of the shorts, 26% of the profit,
 * 59% of the stops; when BTC rose 4%+ within 3 days after the entry it cut −96% (48% stops), the rest made +52%.
 * Fewer than 60 daily candles (a new coin) → no trend → the short is allowed, as the study counted it.
 */
const DAY = 86_400_000;
export type ShortDailyTrend = { block: boolean; pdi: number | null; ndi: number | null; bars: number };

/** Pure: Wilder DI(14) on the closed daily candles before the signal; blocks when +DI > −DI. */
export function shortDailyTrend(c1d: Candle[], signalAt: number): ShortDailyTrend {
  const cs = c1d.filter((c) => c.t + DAY <= signalAt);
  const n = cs.length;
  if (n < 60) return { block: false, pdi: null, ndi: null, bars: n };
  const wilder = (v: number[], p: number): number[] => { const out: number[] = []; let a = v.slice(0, p).reduce((x, y) => x + y, 0) / p; v.forEach((x, i) => { if (i >= p) a = (a * (p - 1) + x) / p; out.push(a); }); return out; };
  const tr = cs.map((x, k) => (k === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - cs[k - 1]!.c), Math.abs(x.l - cs[k - 1]!.c))));
  const pdm = cs.map((x, k) => { if (!k) return 0; const up = x.h - cs[k - 1]!.h, dn = cs[k - 1]!.l - x.l; return up > dn && up > 0 ? up : 0; });
  const ndm = cs.map((x, k) => { if (!k) return 0; const up = x.h - cs[k - 1]!.h, dn = cs[k - 1]!.l - x.l; return dn > up && dn > 0 ? dn : 0; });
  const atr = wilder(tr, 14), i = n - 1;
  if (!(atr[i]! > 0)) return { block: false, pdi: null, ndi: null, bars: n };
  const pdi = (100 * wilder(pdm, 14)[i]!) / atr[i]!, ndi = (100 * wilder(ndm, 14)[i]!) / atr[i]!;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { block: pdi > ndi, pdi: r(pdi), ndi: r(ndi), bars: n };
}
