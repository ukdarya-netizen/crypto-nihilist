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
