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

/** Open trades are followed on 5-minute candles. */
export const TRACK_INTERVAL = "5m" as const;

/**
 * Order-block strength filter: minimum close of the structure-break bar
 * beyond the block, in HTF ATR(14). null = off (measured and recorded only).
 * Chosen from the backtest breakdown by strength ("--ob" in analysis/backtest.ts).
 */
export const OB_MIN_DISPLACEMENT_ATR: number | null = null;
