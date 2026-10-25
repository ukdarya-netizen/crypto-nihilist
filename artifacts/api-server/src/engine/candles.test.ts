import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFrom30m, closedOnly, type Candle } from "./candles";

const M30 = 30 * 60_000;
const H4 = 4 * 60 * 60_000;
const T0 = Date.UTC(2026, 9, 20); // 00:00 UTC

function bars30(count: number, start = T0): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ t: start + i * M30, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i }));
}

test("4h bars are built from complete sets of eight 30m bars, closed only", () => {
  const base = bars30(20); // 10 hours
  const now = T0 + 10 * 60 * 60_000;
  const { bars, missing } = aggregateFrom30m(base, "4h", null, now);
  assert.equal(missing, null);
  assert.equal(bars.length, 2); // 00-04 and 04-08; 08-12 is still forming
  assert.deepEqual(bars[0], { t: T0, o: 10, h: 18, l: 9, c: 17.5 });
  assert.equal(bars[1].t, T0 + H4);
});

test("a missing 30m bar stops the build and reports the period", () => {
  const base = bars30(16).filter((_, i) => i !== 11);
  const { bars, missing } = aggregateFrom30m(base, "4h", null, T0 + 8 * 60 * 60_000);
  assert.equal(bars.length, 1);
  assert.equal(missing, T0 + H4);
});

test("only periods after the last stored bar are built", () => {
  const base = bars30(16);
  const { bars } = aggregateFrom30m(base, "1h", T0 + 6 * 60 * 60_000, T0 + 8 * 60 * 60_000);
  assert.deepEqual(bars.map((b) => b.t), [T0 + 7 * 60 * 60_000]);
});

test("the forming bar is never used", () => {
  const base = bars30(3);
  assert.equal(closedOnly(base, "30m", T0 + 3 * M30 - 1).length, 2);
});
