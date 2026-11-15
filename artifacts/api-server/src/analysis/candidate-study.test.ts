import assert from "node:assert/strict";
import { test } from "node:test";
import { supertrend, waves } from "./candidate-study";

test("waves: swings of at least 2%", () => {
  assert.equal(waves([100, 101, 102, 103]), 0);
  assert.equal(waves([100, 104, 101, 105, 102, 106]), 4);
});
test("supertrend follows a clear trend", () => {
  const up = Array.from({ length: 60 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const down = up.map((c, i) => ({ t: i, o: 200 - i, h: 201 - i, l: 199 - i, c: 199.5 - i }));
  assert.equal(supertrend(up), 1);
  assert.equal(supertrend(down), -1);
});

test("structure series (owner 2026-11-15): bar by bar, no later bar used; an up-trend reads as up", async () => {
  const { structureSeries } = await import("./candidate-study");
  const cs = Array.from({ length: 400 }, (_, i) => {
    const base = 100 + i * 0.2 + 3 * Math.sin(i / 6);
    return { t: i * 3_600_000, o: base, h: base + 1, l: base - 1, c: base + 0.3, v: 1 };
  });
  const full = structureSeries(cs as never);
  const part = structureSeries(cs.slice(0, 250) as never);
  assert.deepEqual(part, full.slice(0, 250));
  assert.equal(full[399]!.it, 1);
});

test("Lucy's VSA (owner 2026-11-15): Welkin letters as her indicator; a bright bar at a 20-bar low with a confirming bar = BUY", async () => {
  const { vsaSeries } = await import("./candidate-study");
  const H4 = 4 * 3_600_000;
  const cs = Array.from({ length: 160 }, (_, i) => ({ t: i * H4, o: 100, h: 101, l: 99, c: 100.2, v: 1 }));
  cs[150] = { t: 150 * H4, o: 99, h: 100, l: 90, c: 99.5, v: 1 };     // lowest low of 20, closes in the upper half
  cs[151] = { t: 151 * H4, o: 99.5, h: 100, l: 95, c: 99.8, v: 1 };   // above the middle (95), no lower low
  const fut = new Map(cs.map((c, i) => [c.t, i === 150 ? 1000 : 100 + (i % 3)] as [number, number]));
  const rows = vsaSeries(cs as never, fut, null);
  assert.equal(rows[150]!.letter, 5);   // W
  assert.equal(rows[151]!.buy, true);
  assert.equal(rows[140]!.bright, false);
});
