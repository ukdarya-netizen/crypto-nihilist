/**
 * Crypto Nihilist setup: SMC order block on the higher timeframe (4h / 1D)
 * + internal change of character (CHoCH) on the lower timeframe (30m / 1h).
 *
 * Long (short is the mirror):
 *  1. The HTF has an active bullish order block (LuxAlgo internal or swing
 *     OB, not mitigated as of the last CLOSED HTF bar).
 *  2. A closed LTF bar trades into the block: low <= block top while the
 *     low stays >= block bottom. A low below the bottom breaks the block
 *     for this setup.
 *  3. Within `touchWindowBars` LTF bars after the last bar inside the block,
 *     the LTF internal structure flips up (bullish CHoCH, close above the
 *     last internal high) -> signal on that bar.
 *  Stop: below the lowest low since the first touch (the reaction low)
 *  minus 0.1 x ATR(14) of the LTF ("extreme" mode) or below the block
 *  bottom ("ob" mode). Targets: the nearest unbroken HTF pivot high above
 *  the entry (TP1) and the next one (TP2). Without any unbroken high above
 *  (price discovery): TP1 = 2R, TP2 = 3R.
 *  One trade per order block per setup.
 */
import { INTERVAL_MS, type Candle, type Interval } from "./candles";
import { SmcEngine, type OrderBlock, type PivotPoint, type SmcSnapshot } from "./smc";

export type Side = "long" | "short";
export type HtfInterval = "4h" | "1d";
export type LtfInterval = "30m" | "1h";

export type SetupOptions = {
  touchWindowBars: number;
  stopMode: "extreme" | "ob";
  stopAtrBuffer: number;
  minRr: number;
  maxRiskPct: number;
  /** Which HTF order blocks to trade. */
  blockScopes: Array<"internal" | "swing">;
  /** Research only: a block may give another signal after a new touch (live: one trade per block). */
  reuseBlocks: boolean;
};

export const DEFAULT_SETUP_OPTIONS: SetupOptions = {
  touchWindowBars: 12,
  stopMode: "extreme",
  stopAtrBuffer: 0.1,
  minRr: 1,
  maxRiskPct: 20,
  blockScopes: ["internal", "swing"],
  reuseBlocks: false,
};

export type SetupSignal = {
  setup: string;
  htf: HtfInterval;
  ltf: LtfInterval;
  side: Side;
  /** LTF bar open time of the CHoCH bar. */
  barTime: number;
  /** LTF bar close time = moment the signal is known. */
  signalAt: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  riskPct: number;
  rr1: number;
  rr2: number;
  targetsSource: "structure" | "r_multiple";
  block: OrderBlock;
  firstTouchAt: number;
  lastTouchAt: number;
  extreme: number;
  chochLevel: number;
  htfSwingTrend: number;
  htfInternalTrend: number;
  ltfAtr: number;
};

export type SetupRejection = {
  setup: string;
  side: Side;
  barTime: number;
  signalAt: number;
  reason: string;
  blockId: string;
  details: Record<string, number | string | null>;
};

export function setupName(htf: HtfInterval, ltf: LtfInterval, side: Side): string {
  return `${htf}_${ltf}_${side}`;
}

type Zone = {
  block: OrderBlock;
  side: Side;
  firstTouchIndex: number | null;
  firstTouchAt: number | null;
  lastTouchIndex: number | null;
  lastTouchAt: number | null;
  extreme: number | null;
  broken: boolean;
  used: boolean;
};

type HtfState = { closeAt: number; index: number; snapshot: SmcSnapshot };

/** Wilder ATR(14) values per bar (null until seeded). */
export function atrSeries(candles: Candle[], length = 14): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  let atr: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const p = i > 0 ? candles[i - 1] : null;
    const tr = p ? Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)) : c.h - c.l;
    if (atr === null) {
      sum += tr;
      if (i + 1 === length) atr = sum / length;
    } else {
      atr = (atr * (length - 1) + tr) / length;
    }
    out.push(atr);
  }
  return out;
}

/** HTF pivot levels still unbroken at `uptoIndex` (no later HTF bar traded through them). */
export function unbrokenLevels(
  pivots: PivotPoint[], htf: Candle[], uptoIndex: number, side: Side,
): number[] {
  const levels: number[] = [];
  const indexByTime = new Map<number, number>();
  for (let i = 0; i <= uptoIndex; i++) indexByTime.set(htf[i].t, i);
  const seen = new Set<number>();
  for (const p of pivots) {
    const start = indexByTime.get(p.time);
    if (start === undefined || seen.has(p.level)) continue;
    let broken = false;
    for (let i = start + 1; i <= uptoIndex; i++) {
      if (side === "long" ? htf[i].h > p.level : htf[i].l < p.level) { broken = true; break; }
    }
    if (!broken) { levels.push(p.level); seen.add(p.level); }
  }
  return levels.sort((a, b) => (side === "long" ? a - b : b - a));
}

export type EvaluateInput = {
  htf: HtfInterval;
  ltf: LtfInterval;
  htfCandles: Candle[];
  ltfCandles: Candle[];
  sides?: Side[];
  options?: Partial<SetupOptions>;
};

/**
 * Walks the LTF series bar by bar; at every LTF bar only HTF information
 * from HTF bars already closed is used (no lookahead).
 */
export function evaluateSetups(input: EvaluateInput): { signals: SetupSignal[]; rejections: SetupRejection[] } {
  const options = { ...DEFAULT_SETUP_OPTIONS, ...(input.options ?? {}) };
  const sides = input.sides ?? ["long", "short"];
  const htfSpan = INTERVAL_MS[input.htf as Interval];
  const ltfSpan = INTERVAL_MS[input.ltf as Interval];
  const { htfCandles, ltfCandles } = input;
  const signals: SetupSignal[] = [];
  const rejections: SetupRejection[] = [];
  if (!htfCandles.length || !ltfCandles.length) return { signals, rejections };

  // HTF snapshots only where the LTF series needs them.
  const firstNeeded = ltfCandles[0].t - htfSpan;
  const htfEngine = new SmcEngine();
  const htfStates: HtfState[] = [];
  htfCandles.forEach((candle, index) => {
    htfEngine.push(candle);
    const closeAt = candle.t + htfSpan;
    if (closeAt >= firstNeeded) htfStates.push({ closeAt, index, snapshot: htfEngine.snapshot() });
  });

  const ltfEngine = new SmcEngine();
  const atr = atrSeries(ltfCandles);
  const zones = new Map<string, Zone>();
  let htfPointer = -1;

  for (let j = 0; j < ltfCandles.length; j++) {
    const bar = ltfCandles[j];
    const closeAt = bar.t + ltfSpan;
    const events = ltfEngine.push(bar);
    while (htfPointer + 1 < htfStates.length && htfStates[htfPointer + 1].closeAt <= closeAt) htfPointer++;
    if (htfPointer < 0) continue;
    const htfState = htfStates[htfPointer];
    const snap = htfState.snapshot;

    // Active HTF blocks as of the last closed HTF bar.
    const active = new Map<string, OrderBlock>();
    for (const block of [...snap.internalOrderBlocks, ...snap.swingOrderBlocks]) {
      if (!options.blockScopes.includes(block.scope)) continue;
      if (block.createdAt + htfSpan > closeAt) continue;
      const side: Side = block.bias === 1 ? "long" : "short";
      if (!sides.includes(side)) continue;
      active.set(block.id, block);
    }
    for (const [id, zone] of zones) if (!active.has(id) && !zone.used) zones.delete(id);
    for (const [id, block] of active) {
      if (!zones.has(id)) {
        zones.set(id, {
          block, side: block.bias === 1 ? "long" : "short",
          firstTouchIndex: null, firstTouchAt: null, lastTouchIndex: null, lastTouchAt: null,
          extreme: null, broken: false, used: false,
        });
      }
    }

    // Touches on this LTF bar.
    for (const zone of zones.values()) {
      if (zone.broken || zone.used) continue;
      const b = zone.block;
      if (zone.side === "long") {
        if (bar.l < b.bottom) { zone.broken = true; continue; }
        if (bar.l <= b.top) {
          if (zone.firstTouchIndex === null) { zone.firstTouchIndex = j; zone.firstTouchAt = bar.t; }
          zone.lastTouchIndex = j; zone.lastTouchAt = bar.t;
        }
        if (zone.firstTouchIndex !== null) zone.extreme = Math.min(zone.extreme ?? bar.l, bar.l);
      } else {
        if (bar.h > b.top) { zone.broken = true; continue; }
        if (bar.h >= b.bottom) {
          if (zone.firstTouchIndex === null) { zone.firstTouchIndex = j; zone.firstTouchAt = bar.t; }
          zone.lastTouchIndex = j; zone.lastTouchAt = bar.t;
        }
        if (zone.firstTouchIndex !== null) zone.extreme = Math.max(zone.extreme ?? bar.h, bar.h);
      }
    }

    for (const event of events) {
      if (event.scope !== "internal" || event.kind !== "CHOCH") continue;
      const side: Side = event.dir === 1 ? "long" : "short";
      if (!sides.includes(side)) continue;
      const candidates = [...zones.values()].filter((z) =>
        z.side === side && !z.broken && !z.used && z.lastTouchIndex !== null &&
        j - z.lastTouchIndex <= options.touchWindowBars);
      if (!candidates.length) continue;
      // The block price reacted from most recently; ties -> the one nearest to price.
      candidates.sort((a, b) => (b.lastTouchIndex! - a.lastTouchIndex!) ||
        (side === "long" ? b.block.top - a.block.top : a.block.bottom - b.block.bottom));
      const zone = candidates[0];
      const touched = { extreme: zone.extreme, firstTouchAt: zone.firstTouchAt, lastTouchAt: zone.lastTouchAt };
      if (options.reuseBlocks) {
        // The next signal from this block needs a fresh touch after this one.
        zone.firstTouchIndex = null; zone.firstTouchAt = null;
        zone.lastTouchIndex = null; zone.lastTouchAt = null; zone.extreme = null;
      } else {
        zone.used = true;
      }
      const setup = setupName(input.htf, input.ltf, side);
      const ltfAtr = atr[j] ?? (bar.h - bar.l);
      const entry = bar.c;
      const reject = (reason: string, details: Record<string, number | string | null> = {}) => {
        rejections.push({ setup, side, barTime: bar.t, signalAt: closeAt, reason, blockId: zone.block.id, details });
      };
      const extreme = touched.extreme as number;
      let stop: number;
      if (side === "long") {
        const base = options.stopMode === "ob" ? Math.min(zone.block.bottom, extreme) : extreme;
        stop = base - options.stopAtrBuffer * ltfAtr;
      } else {
        const base = options.stopMode === "ob" ? Math.max(zone.block.top, extreme) : extreme;
        stop = base + options.stopAtrBuffer * ltfAtr;
      }
      const risk = side === "long" ? entry - stop : stop - entry;
      if (!(risk > 0) || stop <= 0) { reject("stop_not_behind_entry", { entry, stop }); continue; }
      const riskPct = (risk / entry) * 100;
      if (riskPct > options.maxRiskPct) { reject("risk_too_large", { riskPct: round(riskPct, 2) }); continue; }

      const levelsSource = side === "long" ? snap.pivotHighs : snap.pivotLows;
      const levels = unbrokenLevels(levelsSource, htfCandles, htfState.index, side)
        .filter((level) => (side === "long" ? level > entry : level < entry));
      let tp1: number;
      let tp2: number;
      let targetsSource: "structure" | "r_multiple" = "structure";
      const dir = side === "long" ? 1 : -1;
      if (!levels.length) {
        targetsSource = "r_multiple";
        tp1 = entry + dir * 2 * risk;
        tp2 = entry + dir * 3 * risk;
      } else {
        tp1 = levels[0];
        tp2 = levels.length > 1 ? levels[1] : entry + dir * 2 * Math.abs(tp1 - entry);
      }
      const rr1 = Math.abs(tp1 - entry) / risk;
      const rr2 = Math.abs(tp2 - entry) / risk;
      if (rr1 < options.minRr) { reject("rr_too_low", { rr1: round(rr1, 2), tp1, entry, stop }); continue; }

      signals.push({
        setup, htf: input.htf, ltf: input.ltf, side,
        barTime: bar.t, signalAt: closeAt, entry, stop, tp1, tp2,
        riskPct: round(riskPct, 3), rr1: round(rr1, 3), rr2: round(rr2, 3), targetsSource,
        block: zone.block,
        firstTouchAt: touched.firstTouchAt as number,
        lastTouchAt: touched.lastTouchAt as number,
        extreme, chochLevel: event.level,
        htfSwingTrend: snap.swingTrend, htfInternalTrend: snap.internalTrend,
        ltfAtr,
      });
    }
  }
  return { signals, rejections };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
