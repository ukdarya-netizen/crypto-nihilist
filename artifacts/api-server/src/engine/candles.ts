export type Candle = {
  /** Bar open time, ms UTC. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type Interval = "5m" | "30m" | "1h" | "4h" | "1d";

export const INTERVAL_MS: Record<Interval, number> = {
  "5m": 5 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Only bars whose close time has passed. The forming bar is never used. */
export function closedOnly(candles: Candle[], interval: Interval, now: number): Candle[] {
  const span = INTERVAL_MS[interval];
  return candles.filter((c) => c.t + span <= now);
}

/** Sorted by time, one bar per open time (last wins), finite OHLC only. */
export function normalizeCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
    if (c.h < c.l || c.o <= 0 || c.c <= 0 || c.l <= 0) continue;
    byTime.set(c.t, c);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function mergeCandles(older: Candle[], newer: Candle[], keep: number): Candle[] {
  const merged = normalizeCandles([...older, ...newer]);
  return merged.length > keep ? merged.slice(merged.length - keep) : merged;
}

/**
 * Builds closed `interval` bars after `afterT` from 30m bars. A period is
 * built only when all of its 30m bars are present; the first incomplete
 * period stops the build (returned in `missing`).
 */
export function aggregateFrom30m(
  base: Candle[], interval: Interval, afterT: number | null, now: number,
): { bars: Candle[]; missing: number | null } {
  const span = INTERVAL_MS[interval];
  const step = INTERVAL_MS["30m"];
  const per = span / step;
  const byTime = new Map(base.map((c) => [c.t, c]));
  const bars: Candle[] = [];
  if (!base.length) return { bars, missing: null };
  let start = afterT === null ? Math.ceil(base[0].t / span) * span : afterT + span;
  for (; start + span <= now; start += span) {
    const parts: Candle[] = [];
    for (let k = 0; k < per; k++) {
      const c = byTime.get(start + k * step);
      if (!c) return { bars, missing: start };
      parts.push(c);
    }
    bars.push({
      t: start,
      o: parts[0].o,
      h: Math.max(...parts.map((p) => p.h)),
      l: Math.min(...parts.map((p) => p.l)),
      c: parts[parts.length - 1].c,
    });
  }
  return { bars, missing: null };
}
