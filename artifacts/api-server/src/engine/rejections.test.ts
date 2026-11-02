import assert from "node:assert/strict";
import test from "node:test";
import { followRejection, rejectionLevels, type RejectionState } from "./rejection-follow";

const M30 = 30 * 60_000;
const c = (i: number, l: number, h: number) => ({ t: i * M30, o: (l + h) / 2, h, l, c: (l + h) / 2 });
const base = (over: Partial<RejectionState> = {}): RejectionState => ({
  side: "long", entry: 100, stop: 93, signalAt: M30, windowEnd: 10 * M30,
  first: null, firstAt: null, sameCandle: false, peakPct: 0, lowPct: 0, lastCandleT: null, ...over,
});

test("rejected long: +10% before the stop; peak kept to the end of the window", () => {
  let { state, done } = followRejection(base(), [c(0, 50, 200), c(1, 98, 104), c(2, 101, 111), c(3, 92, 105)], 5 * M30);
  assert.equal(state.first, "plus10");       // candle 0 is before the entry and is ignored
  assert.equal(state.firstAt, 3 * M30);
  assert.equal(done, false);
  ({ state, done } = followRejection(state, [c(4, 100, 115), ...Array.from({ length: 6 }, (_, i) => c(5 + i, 100, 101))], 12 * M30));
  assert.equal(done, true);
  assert.equal(state.first, "plus10");
  assert.equal(Math.round(state.peakPct), 15);
  assert.equal(Math.round(state.lowPct), -8);
});

test("stop and +10% in one candle: stop first, flagged", () => {
  const { state } = followRejection(base(), [c(1, 92, 111)], 3 * M30);
  assert.equal(state.first, "stop");
  assert.equal(state.sameCandle, true);
});

test("short mirrored; window ends with neither", () => {
  const { state, done } = followRejection(base({ side: "short", stop: 107 }), Array.from({ length: 9 }, (_, i) => c(1 + i, 95, 104)), 11 * M30);
  assert.equal(done, true);
  assert.equal(state.first, "none");
  assert.equal(Math.round(state.peakPct), 5);
});

test("levels: details first; else the signal bar close and the stop % recorded; wrong-side stop dropped", () => {
  const bars = [{ t: 1000, o: 1, h: 1, l: 1, c: 50 }];
  assert.deepEqual(rejectionLevels({ id: 1, symbol: "X", setup: "4h_30m_long", bar_time: "1000", reason: "r", details: { entry: 10, stop: 9 } }, bars), { entry: 10, stop: 9 });
  assert.deepEqual(rejectionLevels({ id: 1, symbol: "X", setup: "4h_30m_short", bar_time: "1000", reason: "risk_too_large", details: { riskPct: 25 } }, bars), { entry: 50, stop: 62.5 });
  assert.deepEqual(rejectionLevels({ id: 1, symbol: "X", setup: "4h_30m_long", bar_time: "1000", reason: "stop_not_behind_entry", details: { entry: 10, stop: 11 } }, bars), { entry: 10, stop: null });
});
