import assert from "node:assert/strict";
import { test } from "node:test";
import { longBreakStrength } from "./entry-rules-1126";

test("long only on a break candle of 3% or more; unknown candle = no long (owner 2026-11-26)", () => {
  assert.equal(longBreakStrength({ rangePct: 3 }).pass, true);
  assert.equal(longBreakStrength({ rangePct: 2.99 }).pass, false);
  assert.equal(longBreakStrength({ rangePct: null }).pass, false);
  assert.equal(longBreakStrength(null).pass, false);
});
