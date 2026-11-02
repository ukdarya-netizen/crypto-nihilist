import type { Candle } from "./candles";

/**
 * The structure-break (CHoCH) bar in LTF ATR: range, body, close position.
 * Observation only (owner 2026-11-02): recorded to test "candle size" later.
 */
export function chochBarMetrics(bar: Candle | undefined, ltfAtr: number, side: "long" | "short"): Record<string, number | null> | null {
  if (!bar || !(ltfAtr > 0)) return null;
  const range = bar.h - bar.l;
  const body = (bar.c - bar.o) * (side === "long" ? 1 : -1);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    rangeAtr: r(range / ltfAtr),
    bodyAtr: r(body / ltfAtr),
    rangePct: r((range / bar.o) * 100),
    bodyPct: r((body / bar.o) * 100),
    closePos: range > 0 ? r(side === "long" ? (bar.c - bar.l) / range : (bar.h - bar.c) / range) : null,
  };
}
