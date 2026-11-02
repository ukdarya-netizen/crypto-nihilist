/**
 * Trajectory (owner 2026-10-26: see when, after the OB touch and the break,
 * flow comes in for the move):
 *  - before entry: at the first touch of the block, then every 30 minutes
 *    up to the signal (labels "touch", "-90m" … relative to the signal);
 *  - after entry: +15m, then every 30 minutes for the first 24 hours, then
 *    every 4 hours until the trade closes;
 *  - after break-even: every hour for up to 72 hours, even if the trade closes.
 * Each point = price vs entry + technical picture + CoinGlass flow at that moment.
 */
const M = 60_000;
const H = 60 * M;
export const POST_BREAKEVEN_WINDOW_MS = 72 * H;

export function trajectoryPoints(signalAt: number, firstTouchAt: number | null, endAt: number): Array<{ label: string; offsetMs: number }> {
  const out: Array<{ label: string; offsetMs: number }> = [];
  if (firstTouchAt && firstTouchAt < signalAt) {
    const pre = signalAt - firstTouchAt;
    out.push({ label: "touch", offsetMs: -pre });
    for (let m = Math.floor(pre / M / 30) * 30; m >= 30; m -= 30) {
      if (m * M < pre && out.length < 25) out.push({ label: `-${m}m`, offsetMs: -m * M });
    }
  }
  const life = endAt - signalAt;
  if (15 * M <= life) out.push({ label: "+15m", offsetMs: 15 * M });
  for (let m = 30; m <= 24 * 60 && m * M <= life; m += 30) out.push({ label: `+${m}m`, offsetMs: m * M });
  for (let h = 28; h * 60 * M <= life; h += 4) out.push({ label: `+${h}h`, offsetMs: h * 60 * M });
  return out;
}

/** Hourly observations after the stop first moves to entry, capped at 72 hours. */
export function postBreakevenTrajectoryPoints(beAt: number, endAt: number): Array<{ label: string; offsetMs: number }> {
  const life = Math.min(POST_BREAKEVEN_WINDOW_MS, endAt - beAt);
  const out: Array<{ label: string; offsetMs: number }> = [];
  for (let h = 1; h <= 72 && h * H <= life; h += 1) {
    out.push({ label: `be+${h}h`, offsetMs: h * H });
  }
  return out;
}
