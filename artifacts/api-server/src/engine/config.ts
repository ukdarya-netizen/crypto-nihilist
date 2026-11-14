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
export const SHORT_TAKE_AT_PCT: number | null = null; // off since 2026-11-10 (partial +10% below)
/**
 * Longs exit (owner 2026-11-10): the WHOLE long closed at +10% (no long take before — only trailing from +15%).
 * Applies to every new long and to open longs that have not reached +10% yet; an open long already past +10%
 * keeps break-even and the trailing stop from +15%.
 */
export const LONG_TAKE_AT_PCT: number | null = null; // off since 2026-11-10 (partial +10% below)
export function takeAtPctFor(side: "long" | "short", peakPct = 0): number | null {
  const take = side === "short" ? SHORT_TAKE_AT_PCT : LONG_TAKE_AT_PCT;
  return take !== null && peakPct < take ? take : null;
}

/**
 * Trade management (owner 2026-11-10, longs and shorts, as AltBullet): break-even at +5%; at +10% half of the
 * position is closed (TP 1, the stop is already at entry); from +15% the trailing stop (peak − 10 p.p.) leads the
 * rest. No full take. Applies to new signals and to every open trade without a structural TP 1 (targets_source
 * "trailing_only" becomes "pct10"; their TP 1 is the +10% price).
 */
export const PARTIAL_AT_PCT = 10;
export const PCT_TARGETS_SOURCE = "pct10";
/** TP 1 price at +PARTIAL_AT_PCT% in the trade's direction. */
export const partialPrice = (side: "long" | "short", entry: number) =>
  entry * (1 + (side === "long" ? 1 : -1) * PARTIAL_AT_PCT / 100);
export const NO_TP_TARGETS_SOURCE = "trailing_only";

/**
 * BTC (owner 2026-11-10): the altcoin percentages (stop +3% beyond the structure, break-even +5%, short take +8%,
 * long trailing from +15%) do not fit BTC — an 8% BTC move is huge. BTC is managed as in BTC Bullet:
 * stop 0.3% beyond the structural stop; TP 1 at 1.5R — 50% closed, stop to entry; TP 2 at 3R — the rest closed.
 * No +5% break-even, no +8% take, no trailing. Applies to new BTC signals.
 */
export const BTC_SYMBOLS = new Set(["BTC-USDT"]);
export const BTC_STOP_EXTRA_PCT = 0.3;
export const BTC_TARGETS_R = [1.5, 3] as const;
export const BTC_TARGETS_SOURCE = "btc_r";
export const isBtc = (symbol: string) => BTC_SYMBOLS.has(symbol);
/** BTC targets from the entry and the stop: [TP 1, TP 2] at 1.5R and 3R. */
export function btcTargets(side: "long" | "short", entry: number, stop: number): [number, number] {
  const r = Math.abs(entry - stop) * (side === "long" ? 1 : -1);
  return [entry + BTC_TARGETS_R[0] * r, entry + BTC_TARGETS_R[1] * r];
}

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
 * Owner 2026-11-05: no long on a quiet coin — ATR(14) of the 1H candles at the signal.
 * Owner 2026-11-10 (final study, 293 longs 25.10–09.11): raised from 1.2% to 1.9%. By ATR quartile the
 * share reaching +10% before the stop goes 4% → 6% → 7% → 32%; ATR ≥ 1.9%: 78 longs, +0.06% a trade
 * (both halves ≈ 0), 31% stops — every other long variant lost (−2.85% a trade overall).
 * Unknown ATR → not rejected. The reason code keeps its name (atr1h_below_1_2pct) for the history.
 */
export const ENTRY_FILTER_MIN_ATR1H_PCT = 1.9;

/**
 * Owner 2026-11-14 (exit study, 352 shorts 25.10–13.11, current management simulated on 15m): no ISOLATED short.
 * A short is opened only when at least 13 other shorts came out over the whole market in the 24 h before it
 * (published shorts plus shorts rejected by this rule, one per coin). Shorts with 12 or fewer: 58 of 352,
 * −63% in sum, 41–42% stops in both halves of the period; the rest +3.5…+3.8% a trade in both halves. The only
 * short rule that held when chosen on the first half and checked on the second.
 */
export const SHORT_MIN_MARKET_SHORTS_24H = 13;

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
