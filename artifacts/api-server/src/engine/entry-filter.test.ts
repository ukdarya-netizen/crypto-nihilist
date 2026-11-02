import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFilter } from "./config";
import { chochBarMetrics } from "./choch-bar";

const H = 3_600_000;

test("entry filter: stop >= 7% and block <= 300h passes", () => {
  const r = entryFilter({ riskPct: 7.2, signalAt: 1000 * H, blockCreatedAt: 800 * H });
  assert.equal(r.pass, true);
  assert.equal(r.reason, null);
  assert.equal(r.blockAgeH, 200);
});

test("entry filter: tight stop or old block goes to shadow with the reason", () => {
  assert.equal(entryFilter({ riskPct: 5, signalAt: 1000 * H, blockCreatedAt: 900 * H }).reason, "risk_below_7pct");
  assert.equal(entryFilter({ riskPct: 9, signalAt: 1000 * H, blockCreatedAt: 600 * H }).reason, "block_older_300h");
  assert.equal(entryFilter({ riskPct: 9, signalAt: 1000 * H, blockCreatedAt: null, blockTime: 650 * H }).reason, "block_older_300h");
  assert.equal(entryFilter({ riskPct: 9, signalAt: 1000 * H }).reason, "block_age_unknown");
});

test("CHoCH bar metrics in ATR, mirrored for shorts", () => {
  const bar = { t: 0, o: 100, h: 104, l: 99, c: 103, v: 0 } as never;
  const l = chochBarMetrics(bar, 2, "long")!;
  assert.equal(l.rangeAtr, 2.5);
  assert.equal(l.bodyAtr, 1.5);
  assert.equal(l.closePos, 0.8);
  const s = chochBarMetrics(bar, 2, "short")!;
  assert.equal(s.bodyAtr, -1.5);
  assert.equal(s.closePos, 0.2);
});
