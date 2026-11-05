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
 * No take profit (owner 2026-11-02): targets from other order blocks were the
 * wrong idea; trades are managed by break-even at +5% and the trailing stop
 * from +15% only. The nearest HTF level is still computed and stored in tp1
 * for research, but it is never traded; such signals carry targets_source
 * "trailing_only". Trades opened before keep their TP1.
 */
export const TAKE_PROFIT_ENABLED = false;

/**
 * Shorts exit (owner 2026-11-05): break-even at +5% (as before) and the WHOLE short closed at +8%.
 * Live shorts 26.10-05.11: current management -104% in sum, this one +135%. Applies to open shorts
 * that have not reached +8% yet and to every new short. Longs unchanged (trailing from +15%).
 */
export const SHORT_TAKE_AT_PCT: number | null = 8;
export function takeAtPctFor(side: "long" | "short", peakPct = 0): number | null {
  return side === "short" && SHORT_TAKE_AT_PCT !== null && peakPct < SHORT_TAKE_AT_PCT ? SHORT_TAKE_AT_PCT : null;
}
export const NO_TP_TARGETS_SOURCE = "trailing_only";

/**
 * Entry filter for LONGS (owner 2026-11-02). A long is opened only when:
 *   - the stop is at least 7% from the entry (TA stop + 3%);
 *   - the order block is at most 300 hours old at the signal;
 *   - the order block is at least 4% of the price high.
 * Live, 202 closed longs 25.10-02.11: 26 passed, 10 of 14 trailing profits,
 * stops 31% (all longs 64%), avg +2.92% (all -2.86%). 60-day backtest
 * (stop + block age, 495 coins): 564 longs, avg +1.78%, stops 30%, both
 * halves and both months positive (all longs +0.04%, October -2.07%).
 * Shorts are not filtered: neither condition helped shorts live or on the
 * backtest. A long that fails is not opened; the rejection and its reason go
 * to nh_decisions.
 */
export const ENTRY_FILTER_MIN_RISK_PCT = 7;
export const ENTRY_FILTER_MAX_BLOCK_AGE_H = 300;
export const ENTRY_FILTER_MIN_BLOCK_SIZE_PCT = 4;
/**
 * Owner 2026-11-05: no long on a quiet coin — ATR(14) of the 1H candles below 1.2% of the price at
 * the signal. Over the current filter (45 longs since 25.10) it removes BANK 01.11 (stop) and three
 * flat trades (PUNDIX, KNC, AGLD); on all 275 longs: 98 removed → 4 reached +10%, 75 stopped.
 * Unknown ATR → not rejected.
 */
export const ENTRY_FILTER_MIN_ATR1H_PCT = 1.2;

export type EntryFilterResult = {
  pass: boolean; reason: string | null; riskPct: number; blockAgeH: number | null; blockSizePct: number;
  atrPct1h?: number | null;
};

export function entryFilter(input: {
  side: "long" | "short"; riskPct: number; entry: number; blockTop: number; blockBottom: number;
  signalAt: number; blockCreatedAt?: number | null; blockTime?: number | null;
  atrPct1h?: number | null;
}): EntryFilterResult {
  const origin = input.blockCreatedAt ?? input.blockTime ?? null;
  const blockAgeH = origin !== null ? (input.signalAt - origin) / 3_600_000 : null;
  const blockSizePct = ((input.blockTop - input.blockBottom) / input.entry) * 100;
  const reasons: string[] = [];
  if (input.side === "long") {
    if (!(input.riskPct >= ENTRY_FILTER_MIN_RISK_PCT)) reasons.push("risk_below_7pct");
    if (blockAgeH === null) reasons.push("block_age_unknown");
    else if (blockAgeH > ENTRY_FILTER_MAX_BLOCK_AGE_H) reasons.push("block_older_300h");
    if (!(blockSizePct >= ENTRY_FILTER_MIN_BLOCK_SIZE_PCT)) reasons.push("block_below_4pct");
    if (input.atrPct1h != null && input.atrPct1h < ENTRY_FILTER_MIN_ATR1H_PCT) reasons.push("atr1h_below_1_2pct");
  }
  return { pass: reasons.length === 0, reason: reasons.length ? reasons.join(",") : null, riskPct: input.riskPct, blockAgeH, blockSizePct, atrPct1h: input.atrPct1h ?? null };
}

/** Open trades are followed on 5-minute candles. */
export const TRACK_INTERVAL = "5m" as const;

/**
 * Order-block strength filter: minimum close of the structure-break bar
 * beyond the block, in HTF ATR(14). null = off (measured and recorded only).
 * Chosen from the backtest breakdown by strength ("--ob" in analysis/backtest.ts).
 */
export const OB_MIN_DISPLACEMENT_ATR: number | null = null;
