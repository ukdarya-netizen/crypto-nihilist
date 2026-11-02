import type { HtfInterval, LtfInterval } from "./setups";

/** {order block timeframe} × {structure-break timeframe}; each with long and short. */
export const COMBOS: Array<{ htf: HtfInterval; ltf: LtfInterval }> = [
  { htf: "4h", ltf: "30m" }, { htf: "4h", ltf: "1h" },
  { htf: "1d", ltf: "30m" }, { htf: "1d", ltf: "1h" },
];

/** Maximum holding time of a virtual trade by the order block's timeframe. */
export const MAX_HOLD_MS: Record<HtfInterval, number> = { "4h": 7 * 86_400_000, "1d": 21 * 86_400_000 };

/**
 * Setups published to Telegram. Every setup is tracked and counted on the
 * dashboard; only these go to the channel and subscribers. Chosen by the
 * owner from the backtest (empty until then).
 */
export const LIVE_SETUPS: ReadonlySet<string> = new Set<string>(
  // Full forward test (owner, 2026-10-25): every setup goes to Telegram.
  COMBOS.flatMap(({ htf, ltf }) => [`${htf}_${ltf}_long`, `${htf}_${ltf}_short`]),
);

/**
 * AltBullet's break-even: at +5% before TP1 the stop moves to entry (null =
 * only at TP1). On (owner 2026-10-26): in the 60-day backtest it raised avg R
 * in all 8 setups (stops 60-77% -> 43-59%).
 */
export const BREAKEVEN_AT_PCT: number | null = 5;

/**
 * Entry filter (owner 2026-11-02, 255 closed trades 25.10-02.11): a trade is
 * published (live) only when its stop is at least 7% from the entry AND the
 * order block is at most 300 hours old at the signal. Passing: 56 trades,
 * avg +1.35% (+0.12R), stops 21%; rejected: 199, avg -3.59% (-0.63R), stops
 * 69%. Rejected trades are still opened and tracked as shadow (live = false)
 * so both groups keep being measured on new data.
 */
export const ENTRY_FILTER_MIN_RISK_PCT = 7;
export const ENTRY_FILTER_MAX_BLOCK_AGE_H = 300;

export function entryFilter(input: { riskPct: number; signalAt: number; blockCreatedAt?: number | null; blockTime?: number | null }): {
  pass: boolean; reason: string | null; riskPct: number; blockAgeH: number | null;
} {
  const origin = input.blockCreatedAt ?? input.blockTime ?? null;
  const blockAgeH = origin !== null ? (input.signalAt - origin) / 3_600_000 : null;
  const reasons: string[] = [];
  if (!(input.riskPct >= ENTRY_FILTER_MIN_RISK_PCT)) reasons.push("risk_below_7pct");
  if (blockAgeH === null) reasons.push("block_age_unknown");
  else if (blockAgeH > ENTRY_FILTER_MAX_BLOCK_AGE_H) reasons.push("block_older_300h");
  return { pass: reasons.length === 0, reason: reasons.length ? reasons.join(",") : null, riskPct: input.riskPct, blockAgeH };
}

/** Open trades are followed on 5-minute candles. */
export const TRACK_INTERVAL = "5m" as const;

/**
 * Order-block strength filter: minimum close of the structure-break bar
 * beyond the block, in HTF ATR(14). null = off (measured and recorded only).
 * Chosen from the backtest breakdown by strength ("--ob" in analysis/backtest.ts).
 */
export const OB_MIN_DISPLACEMENT_ATR: number | null = null;
