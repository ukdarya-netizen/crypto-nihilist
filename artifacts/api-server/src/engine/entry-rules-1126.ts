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
