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
