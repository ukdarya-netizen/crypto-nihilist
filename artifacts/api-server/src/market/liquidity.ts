/**
 * ICT liquidity around the order block (owner 2026-11-05, from her TradingView indicators: «Sweep + MSS»,
 * «SFP Sweep Liquidity», «2022 Model», «True/Fake Breakout»). Long side (shorts: mirrored candles).
 * On the setup's LTF candles (BingX), window = first touch of the block → signal:
 *  - swing lows = pivot lows (14 bars each side, as in «Sweep + MSS»; 21 as in «SFP Sweep» also given)
 *    formed before the first touch;
 *  - sweep = a candle in the window took a swing low (low below it) and CLOSED back above it (wick sweep);
 *  - where the swept level sat: under the block, inside it, or above it;
 *  - block stop-hunt = a wick below the block bottom that closed back inside/above the bottom;
 *  - equal lows = ≥2 swing lows within 0.2 × ATR of each other (a liquidity pool) under the block, and
 *    whether it was swept;
 *  - FVG after the sweep (2022 model): a bullish gap (low[i] > high[i−2]) between the sweep and the signal;
 *  - sweep candle volume vs the 20 bars before it.
 * Parameters are the indicators' defaults, fixed up front. Pure. Observation only.
 */
export type LBar = { time: number; open: number; high: number; low: number; close: number; volume: number };

function pivotLows(bars: LBar[], len: number, before: number) {
  const out: { i: number; p: number }[] = [];
  for (let i = len; i < bars.length - len; i++) {
    if (bars[i + len]!.time >= before) break; // confirmed before the first touch
    let ok = true;
    for (let k = i - len; k <= i + len && ok; k++) if (k !== i && bars[k]!.low <= bars[i]!.low) ok = false;
    if (ok) out.push({ i, p: bars[i]!.low });
  }
  return out;
}

function atr(bars: LBar[], end: number, n = 14) {
  if (end < n) return null;
  let s = 0;
  for (let k = end - n + 1; k <= end; k++) {
    const b = bars[k]!, p = bars[k - 1]!;
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return s / n;
}

export function liquidityReading(bars: LBar[], firstTouchAt: number, signalAt: number, blockTop: number, blockBottom: number) {
  const w0 = bars.findIndex((b) => b.time >= firstTouchAt);
  let w1 = -1;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.time < signalAt) { w1 = i; break; }
  if (w0 < 0 || w1 < w0) return { reason: "нет свечей окна касания" };
  const a = atr(bars, w0) ?? 0;
  const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const read = (len: number) => {
    const piv = pivotLows(bars, len, bars[w0]!.time);
    // the most recent swing low swept in the window (low below it, close back above)
    let sweep: { lvl: number; i: number; pivAt: number } | null = null;
    for (let i = w0; i <= w1 && !sweep; i++) {
      const b = bars[i]!;
      const hit = piv.filter((p) => b.low < p.p && b.close > p.p).sort((x, y) => y.i - x.i)[0];
      if (hit) sweep = { lvl: hit.p, i, pivAt: hit.i };
    }
    if (!sweep) return { swept: false };
    const b = bars[sweep.i]!;
    const prior = bars.slice(Math.max(0, sweep.i - 20), sweep.i);
    const av = prior.length ? prior.reduce((x, y) => x + y.volume, 0) / prior.length : 0;
    let fvg = false;
    for (let i = Math.max(sweep.i + 2, 2); i <= w1; i++) if (bars[i]!.low > bars[i - 2]!.high) { fvg = true; break; }
    return {
      swept: true,
      levelWhere: sweep.lvl < blockBottom ? "under_block" : sweep.lvl <= blockTop ? "inside_block" : "above_block",
      depthPct: r2(((sweep.lvl - b.low) / sweep.lvl) * 100),
      depthAtr: a ? r2((sweep.lvl - b.low) / a) : null,
      levelAgeBars: sweep.i - sweep.pivAt,
      barsSweepToSignal: w1 - sweep.i + 1,
      sweepVolRel: av ? r2(b.volume / av) : null,
      sweepClosePos: b.high > b.low ? r2((b.close - b.low) / (b.high - b.low)) : null,
      fvgAfterSweep: fvg,
    };
  };
  const win = bars.slice(w0, w1 + 1);
  const minLow = Math.min(...win.map((b) => b.low));
  const huntBar = win.find((b) => b.low < blockBottom && b.close >= blockBottom);
  // equal lows under the block (liquidity pool) from the 14-bar swing lows
  const piv = pivotLows(bars, 14, bars[w0]!.time).filter((p) => p.p < blockBottom * 1.0001);
  let pool: number | null = null;
  for (let x = 0; x < piv.length && pool === null; x++)
    for (let y = x + 1; y < piv.length; y++) if (a && Math.abs(piv[x]!.p - piv[y]!.p) <= 0.2 * a) { pool = Math.min(piv[x]!.p, piv[y]!.p); break; }
  return {
    windowBars: win.length,
    sweep14: read(14),
    sweep21: read(21),
    blockStopHunt: huntBar != null,
    blockStopHuntDepthPct: huntBar ? r2(((blockBottom - huntBar.low) / blockBottom) * 100) : null,
    closedBelowBlock: win.some((b) => b.close < blockBottom),
    lowestVsBlockBottomPct: r2(((minLow - blockBottom) / blockBottom) * 100),
    equalLowsUnderBlock: pool !== null,
    equalLowsSwept: pool !== null ? win.some((b) => b.low < pool! && b.close > pool!) : null,
    reason: null,
  };
}
