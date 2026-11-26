import assert from "node:assert/strict";
import { test } from "node:test";
import { longBreakStrength } from "./entry-rules-1126";

test("long only on a break candle of 3% or more; unknown candle = no long (owner 2026-11-26)", () => {
  assert.equal(longBreakStrength({ rangePct: 3 }).pass, true);
  assert.equal(longBreakStrength({ rangePct: 2.99 }).pass, false);
  assert.equal(longBreakStrength({ rangePct: null }).pass, false);
  assert.equal(longBreakStrength(null).pass, false);
});

test("no short when the coin's own daily +DI is above −DI; under 60 days — allowed (owner 2026-11-26)", async () => {
  const { shortDailyTrend } = await import("./entry-rules-1126");
  const D = 86_400_000;
  const up = Array.from({ length: 80 }, (_, i) => ({ t: i * D, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i }));
  const dn = Array.from({ length: 80 }, (_, i) => ({ t: i * D, o: 200 - i, h: 201 - i, l: 198 - i, c: 199 - i }));
  assert.equal(shortDailyTrend(up as never, 81 * D).block, true);
  assert.equal(shortDailyTrend(dn as never, 81 * D).block, false);
  assert.equal(shortDailyTrend(up.slice(0, 50) as never, 81 * D).block, false);
});
