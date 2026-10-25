import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "./candles";
import { applyCandles, nextMilestone, openTrade, tradeResult } from "./trade";

const M = 5 * 60_000;
const bar = (i: number, l: number, h: number, c = (l + h) / 2): Candle => ({ t: i * M, o: c, h, l, c });

test("milestones: +5, +8, +10, then every +5; one alert per jump (the highest)", () => {
  assert.equal(nextMilestone(0, 4.9), null);
  assert.equal(nextMilestone(0, 5), 5);
  assert.equal(nextMilestone(5, 9), 8);
  assert.equal(nextMilestone(8, 23), 20);
  assert.equal(nextMilestone(20, 24.9), null);
  assert.equal(nextMilestone(195, 260), 250);
});

test("long: TP1 closes half and moves the stop to entry; trailing from +15% at peak − 10 p.p.", () => {
  const t0 = openTrade({ side: "long", entry: 100, stop: 95, tp1: 108, openedAt: 0, maxHoldMs: 10 * 86_400_000 });
  const { state, events } = applyCandles(t0, [
    bar(0, 99, 106),   // +6%: milestone 5
    bar(1, 104, 109),  // TP1 108 (+8 milestone): half closed, stop → 100
    bar(2, 107, 124),  // peak +24%: milestones 10..20, trailing on, stop → 114
    bar(3, 115, 122),
    bar(4, 113.5, 118), // trailing stop 114 hit
  ], M);
  assert.deepEqual(events.map((e) => e.kind), ["milestone", "milestone", "tp1", "milestone", "trailing_on", "closed"]);
  assert.equal(events[3].kind === "milestone" && events[3].milestone, 20);
  assert.equal(state.closeReason, "trailing");
  assert.ok(Math.abs((state.exitPrice ?? 0) - 114) < 1e-9);
  const r = tradeResult(state);
  // 50% at +8% and 50% at +14%, minus 0.1% fees = +10.9%
  assert.ok(Math.abs(r.pnlPct - 10.9) < 1e-6, String(r.pnlPct));
});

test("stop before targets inside one candle; break-even close after TP1", () => {
  const t0 = openTrade({ side: "long", entry: 100, stop: 95, tp1: 104, openedAt: 0, maxHoldMs: 86_400_000 });
  const a = applyCandles(t0, [bar(0, 94, 110)], M);
  assert.equal(a.state.closeReason, "stop");
  assert.equal(a.state.tp1Hit, false);
  const b = applyCandles(t0, [bar(0, 99, 105), bar(1, 99.5, 101)], M);
  assert.equal(b.state.closeReason, "breakeven");
  assert.equal(b.state.exitPrice, 100);
});

test("short mirrors the long; optional AltBullet break-even at +5%", () => {
  const t0 = openTrade({ side: "short", entry: 100, stop: 106, tp1: 85, openedAt: 0, maxHoldMs: 86_400_000, breakevenAtPct: 5 });
  const { state, events } = applyCandles(t0, [bar(0, 94, 101), bar(1, 96, 100.5)], M);
  assert.deepEqual(events.map((e) => e.kind), ["milestone", "breakeven", "closed"]);
  assert.equal(state.closeReason, "breakeven");
  assert.equal(state.exitPrice, 100);
});

test("timeout closes at the candle close", () => {
  const t0 = openTrade({ side: "long", entry: 100, stop: 90, tp1: 130, openedAt: 0, maxHoldMs: 2 * M });
  const { state } = applyCandles(t0, [bar(0, 99, 101), bar(1, 100, 102, 101.5)], M);
  assert.equal(state.closeReason, "timeout");
  assert.equal(state.exitPrice, 101.5);
});
