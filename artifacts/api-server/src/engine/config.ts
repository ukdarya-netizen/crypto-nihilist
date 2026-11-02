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
 * Entry filter (owner 2026-11-02, 255 closed trades 25.10-02.11). A signal is
 * published (live) only when all three hold:
 *   - stop at least 7% from the entry;
 *   - order block at most 300 hours old at the signal;
 *   - longs only: aggregated OI over the last 4 hours up at least 1%.
 * Longs (202 closed): 25 passed, avg +3.33%, stops 20% (5), 8 of 14 trailing
 * profits kept; all longs avg -2.86%, stops 64%.
 * Shorts (53 closed): no OI condition — before short profits OI barely moved
 * (median -0.4% in 4h), a deep OI drop came before B.U. closes instead.
 * Stop + block age: 20 passed, avg +0.86%, stops 2; all shorts avg -1.16%.
 * Signals that fail are not opened (owner: no shadow trades); the rejection
 * and its reason are written to nh_decisions.
 */
export const ENTRY_FILTER_MIN_RISK_PCT = 7;
export const ENTRY_FILTER_MAX_BLOCK_AGE_H = 300;
export const ENTRY_FILTER_MIN_OI_4H_PCT = 1;

export type EntryFilterResult = {
  pass: boolean; reason: string | null; riskPct: number; blockAgeH: number | null; oi4hPct: number | null;
};

/** Stop distance and block age: checked first (no network). */
export function entryFilterGeometry(input: { riskPct: number; signalAt: number; blockCreatedAt?: number | null; blockTime?: number | null }): EntryFilterResult {
  const origin = input.blockCreatedAt ?? input.blockTime ?? null;
  const blockAgeH = origin !== null ? (input.signalAt - origin) / 3_600_000 : null;
  const reasons: string[] = [];
  if (!(input.riskPct >= ENTRY_FILTER_MIN_RISK_PCT)) reasons.push("risk_below_7pct");
  if (blockAgeH === null) reasons.push("block_age_unknown");
  else if (blockAgeH > ENTRY_FILTER_MAX_BLOCK_AGE_H) reasons.push("block_older_300h");
  return { pass: reasons.length === 0, reason: reasons.length ? reasons.join(",") : null, riskPct: input.riskPct, blockAgeH, oi4hPct: null };
}

/** Adds the OI condition (longs only) to a geometry result; OI missing on a long = not published. */
export function entryFilterWithOi(geo: EntryFilterResult, side: "long" | "short", oi4hPct: number | null): EntryFilterResult {
  const reasons = geo.reason ? geo.reason.split(",") : [];
  if (side === "long") {
    if (oi4hPct === null) reasons.push("oi_unknown");
    else if (!(oi4hPct >= ENTRY_FILTER_MIN_OI_4H_PCT)) reasons.push("oi_4h_below_1pct");
  }
  return { ...geo, oi4hPct, pass: reasons.length === 0, reason: reasons.length ? reasons.join(",") : null };
}

/** Open trades are followed on 5-minute candles. */
export const TRACK_INTERVAL = "5m" as const;

/**
 * Order-block strength filter: minimum close of the structure-break bar
 * beyond the block, in HTF ATR(14). null = off (measured and recorded only).
 * Chosen from the backtest breakdown by strength ("--ob" in analysis/backtest.ts).
 */
export const OB_MIN_DISPLACEMENT_ATR: number | null = null;
