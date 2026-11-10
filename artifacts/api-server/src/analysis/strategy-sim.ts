/**
 * Trade-management variants for Nihilist signals (owner 2026-11-03): the same
 * signal followed with different exits, to choose the trading bot's strategy
 * for Nihilist by data. Pure functions, no I/O.
 *
 * A variant is a combination of:
 *   be      — stop to entry once the move reaches +be% (null = never);
 *   take    — the whole rest closed at +take% (null = no fixed take);
 *   partial — `share` of the position closed at +at%, stop to entry;
 *   trail   — from +act% the stop follows the peak at peak − gap p.p.
 * Holding time: as Nihilist (4h block 7 days, 1d block 21 days), closed at
 * the candle close after it. Inside a candle the stop in force at its start
 * is checked first (conservative, as engine/trade.ts); a take, partial or new
 * stop reached in that candle applies from its favourable side. Fees 0.05%
 * per side on the whole size. Results are % of the entry price (×10 on the
 * margin at 10x leverage).
 */
import type { Candle } from "../engine/candles";
import type { Side } from "../engine/setups";
import { TAKER_FEE } from "../engine/trade";

export type Mgmt = {
  id: string;
  label: string;
  be: number | null;
  take: number | null;
  partial: { at: number; share: number } | null;
  trail: { act: number; gap: number } | null;
  /**
   * Levels in R instead of % (owner 2026-11-10: fixed % takes against 7-20% stops give ≤ 1:1). 1R = the trade's
   * own stop distance in %. When set, it replaces be / take / partial.at with R × risk%.
   */
  r?: { be?: number; take?: number; partial?: { at: number; share: number } } | null;
  /** Whole position closed at a side-dependent % (Nihilist today: short +8%, long +10%). Replaces take. */
  takeBySide?: { long: number; short: number } | null;
};

export type SimTrade = {
  id: string; side: Side; entry: number; stop: number; openedAt: number; maxHoldMs: number;
};

export type SimResult = {
  closed: boolean;
  reason: "stop" | "breakeven" | "trailing" | "take" | "timeout" | null;
  closedAt: number | null;
  pnlPct: number;        // net of fees; open trades at the last close
  peakPct: number;
  holdH: number;
};

const mk = (id: string, label: string, p: Partial<Omit<Mgmt, "id" | "label">>): Mgmt =>
  ({ id, label, be: p.be ?? null, take: p.take ?? null, partial: p.partial ?? null, trail: p.trail ?? null, r: p.r ?? null, takeBySide: p.takeBySide ?? null });

/** The variants compared. "source" is exactly how Nihilist itself manages its trades today. */
export function variants(): Mgmt[] {
  // "source" = how Nihilist managed trades until 10.11 (kept for the parity check against live trades).
  const out: Mgmt[] = [
    mk("source", "как вёл Нигилист до 10.11: Б.У. +5%, трейлинг от +15% (пик − 10 п.п.)", { be: 5, trail: { act: 15, gap: 10 } }),
    mk("now", "как ведёт Нигилист сейчас: Б.У. +5%, тейк шорт +8% / лонг +10%", { be: 5, takeBySide: { long: 10, short: 8 } }),
  ];
  for (const be of [null, 5] as const) {
    const bu = be ? `Б.У. +${be}%, ` : "";
    for (const take of [5, 6, 7, 8, 10, 12, 15, 20, 30]) { // 6, 7, 12: owner 2026-11-10 (shorts' take)
      if (be !== null && take <= be) continue;
      out.push(mk(`${be ? `be${be}_` : ""}take${take}`, `${bu}тейк +${take}%`, { be, take }));
    }
    for (const [act, gap] of [[10, 5], [10, 7], [15, 10], [20, 10], [30, 15]] as const) {
      const id = `${be ? `be${be}_` : ""}trail${act}_${gap}`;
      if (id === "be5_trail15_10") continue; // = source
      out.push(mk(id, `${bu}трейлинг от +${act}% (пик − ${gap} п.п.)`, { be, trail: { act, gap } }));
    }
  }
  out.push(mk("be3_trail15_10", "Б.У. +3%, трейлинг от +15% (пик − 10 п.п.)", { be: 3, trail: { act: 15, gap: 10 } }));
  out.push(mk("be8_trail15_10", "Б.У. +8%, трейлинг от +15% (пик − 10 п.п.)", { be: 8, trail: { act: 15, gap: 10 } }));
  out.push(mk("half5_trail15_10", "50% на +5%, Б.У., остаток трейлинг от +15% (пик − 10 п.п.)", { partial: { at: 5, share: 0.5 }, trail: { act: 15, gap: 10 } }));
  out.push(mk("half8_trail15_10", "50% на +8%, Б.У., остаток трейлинг от +15% (пик − 10 п.п.)", { partial: { at: 8, share: 0.5 }, trail: { act: 15, gap: 10 } }));
  out.push(mk("half10_trail20_10", "50% на +10%, Б.У., остаток трейлинг от +20% (пик − 10 п.п.)", { partial: { at: 10, share: 0.5 }, trail: { act: 20, gap: 10 } }));
  out.push(mk("half5_take15", "50% на +5%, Б.У., остаток тейк +15%", { partial: { at: 5, share: 0.5 }, take: 15 }));
  // In R (1R = the trade's own stop distance), owner 2026-11-10.
  for (const k of [1, 1.5, 2, 2.5, 3]) out.push(mk(`take${k}R`, `тейк ${k}R`, { r: { take: k } }));
  for (const k of [2, 3]) out.push(mk(`be1R_take${k}R`, `Б.У. на 1R, тейк ${k}R`, { r: { be: 1, take: k } }));
  out.push(mk("half1R_take2R", "50% на 1R, Б.У., остаток 2R", { r: { partial: { at: 1, share: 0.5 }, take: 2 } }));
  out.push(mk("half1.5R_take3R", "50% на 1,5R, Б.У., остаток 3R (как BTC)", { r: { partial: { at: 1.5, share: 0.5 }, take: 3 } }));
  out.push(mk("half2R_take4R", "50% на 2R, Б.У., остаток 4R", { r: { partial: { at: 2, share: 0.5 }, take: 4 } }));
  return out;
}

/** Follows one trade on closed candles (any span) with one variant. */
export function simulate(t: SimTrade, candles: Candle[], spanMs: number, mIn: Mgmt): SimResult {
  const dir = t.side === "long" ? 1 : -1;
  const riskPct = (Math.abs(t.entry - t.stop) / t.entry) * 100;
  const base: Mgmt = mIn.takeBySide ? { ...mIn, take: mIn.takeBySide[t.side] } : mIn;
  const m: Mgmt = base.r ? {
    ...base,
    be: base.r.be != null ? base.r.be * riskPct : null,
    take: base.r.take != null ? base.r.take * riskPct : null,
    partial: base.r.partial ? { at: base.r.partial.at * riskPct, share: base.r.partial.share } : null,
  } : base;
  const pctOf = (price: number) => ((price - t.entry) / t.entry) * 100 * dir;
  const priceAt = (pct: number) => t.entry * (1 + dir * pct / 100);
  const tighter = (a: number, b: number) => (dir === 1 ? Math.max(a, b) : Math.min(a, b));
  const expiresAt = t.openedAt + t.maxHoldMs;
  let stop = t.stop;
  let rest = 1;
  let realized = 0; // share-weighted % of closed parts
  let peak = 0;
  let beMoved = false;
  let trailing = false;
  let partialDone = false;
  let lastClose: number | null = null;
  let lastAt = t.openedAt;
  const done = (reason: NonNullable<SimResult["reason"]>, at: number, exitPct: number): SimResult => {
    realized += rest * exitPct;
    return { closed: true, reason, closedAt: at, pnlPct: round(realized - 2 * TAKER_FEE * 100), peakPct: peak, holdH: (at - t.openedAt) / 3_600_000 };
  };
  for (const c of candles) {
    if (c.t + spanMs <= t.openedAt) continue;
    const at = c.t + spanMs;
    lastAt = at; lastClose = c.c;
    // 1. Stop in force at the start of the candle.
    if (dir === 1 ? c.l <= stop : c.h >= stop) {
      const reason = trailing ? "trailing" : beMoved || partialDone ? "breakeven" : "stop";
      return done(reason, at, pctOf(stop));
    }
    // 2. Favourable side.
    const best = pctOf(dir === 1 ? c.h : c.l);
    if (best > peak) peak = best;
    if (m.partial && !partialDone && best >= m.partial.at) {
      partialDone = true;
      realized += m.partial.share * m.partial.at;
      rest -= m.partial.share;
      stop = tighter(stop, t.entry);
      beMoved = true;
    }
    if (m.take !== null && best >= m.take) return done("take", at, m.take);
    if (m.be !== null && !beMoved && best >= m.be) { beMoved = true; stop = tighter(stop, t.entry); }
    if (m.trail && peak >= m.trail.act) { trailing = true; stop = tighter(stop, priceAt(peak - m.trail.gap)); }
    // 3. Holding time.
    if (at >= expiresAt) return done("timeout", at, pctOf(c.c));
  }
  const markPct = lastClose === null ? 0 : pctOf(lastClose);
  return { closed: false, reason: null, closedAt: null, pnlPct: round(realized + rest * markPct - 2 * TAKER_FEE * 100), peakPct: peak, holdH: (lastAt - t.openedAt) / 3_600_000 };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export type Row = { tradeId: string; openedAt: number; closedAt: number; pnlPct: number; reason: string; holdH: number; peakPct: number };

export type Stats = {
  n: number; open: number; winPct: number; stopPct: number; flatPct: number; takePct: number; trailPct: number; timeoutPct: number;
  avg: number; sum: number; pf: number | null; maxDd: number; worstStreak: number;
  half1: { n: number; avg: number | null }; half2: { n: number; avg: number | null };
  avgHoldH: number; perDay: number;
  /** [label, count] in order (an array: jsonb would reorder object keys). */
  buckets: Array<[string, number]>;
  hold: Array<[string, number]>;
};

export const BUCKETS: Array<[string, number, number]> = [
  ["< −10%", -Infinity, -10], ["−10…−5%", -10, -5], ["−5…−1%", -5, -1], ["−1…+1%", -1, 1],
  ["+1…+5%", 1, 5], ["+5…+10%", 5, 10], ["+10…+20%", 10, 20], ["+20…+50%", 20, 50], ["> +50%", 50, Infinity],
];
export const HOLD: Array<[string, number, number]> = [
  ["< 4 ч", 0, 4], ["4–24 ч", 4, 24], ["1–3 д", 24, 72], ["3–7 д", 72, 168], ["> 7 д", 168, Infinity],
];

/** Closed trades only; halves split at the middle of the opening times of the closed trades. */
export function stats(rows: Row[], open: number): Stats {
  const xs = [...rows].sort((a, b) => a.closedAt - b.closedAt);
  const n = xs.length;
  const share = (f: (r: Row) => boolean) => (n ? (100 * xs.filter(f).length) / n : 0);
  const sum = xs.reduce((a, r) => a + r.pnlPct, 0);
  const gains = xs.filter((r) => r.pnlPct > 0).reduce((a, r) => a + r.pnlPct, 0);
  const losses = -xs.filter((r) => r.pnlPct < 0).reduce((a, r) => a + r.pnlPct, 0);
  let cum = 0, peakCum = 0, maxDd = 0, streak = 0, worstStreak = 0;
  for (const r of xs) {
    cum += r.pnlPct; peakCum = Math.max(peakCum, cum); maxDd = Math.max(maxDd, peakCum - cum);
    streak = r.pnlPct < 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak);
  }
  const opens = xs.map((r) => r.openedAt);
  const mid = n ? (Math.min(...opens) + Math.max(...opens)) / 2 : 0;
  const half = (first: boolean) => {
    const p = xs.filter((r) => (r.openedAt < mid) === first);
    return { n: p.length, avg: p.length ? round(p.reduce((a, r) => a + r.pnlPct, 0) / p.length) : null };
  };
  const holdSum = xs.reduce((a, r) => a + r.holdH, 0);
  const count = (edges: Array<[string, number, number]>, pick: (r: Row) => number) =>
    edges.map(([k, lo, hi]): [string, number] => [k, xs.filter((r) => pick(r) >= lo && pick(r) < hi).length]);
  return {
    n, open,
    winPct: round(share((r) => r.pnlPct > 0.5)),
    stopPct: round(share((r) => r.reason === "stop")),
    flatPct: round(share((r) => Math.abs(r.pnlPct) <= 0.5)),
    takePct: round(share((r) => r.reason === "take")),
    trailPct: round(share((r) => r.reason === "trailing")),
    timeoutPct: round(share((r) => r.reason === "timeout")),
    avg: n ? round(sum / n) : 0, sum: round(sum), pf: losses > 0 ? round(gains / losses) : null,
    maxDd: round(maxDd), worstStreak,
    half1: half(true), half2: half(false),
    avgHoldH: n ? round(holdSum / n) : 0,
    perDay: holdSum > 0 ? round(sum / (holdSum / 24)) : 0,
    buckets: count(BUCKETS, (r) => r.pnlPct),
    hold: count(HOLD, (r) => r.holdH),
  };
}
