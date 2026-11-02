import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFilterGeometry, entryFilterWithOi } from "./config";
import { chochBarMetrics } from "./choch-bar";

const H = 3_600_000;

test("entry filter: stop >= 7%, block <= 300h and OI 4h up (longs) -> live", () => {
  const geo = entryFilterGeometry({ riskPct: 7.2, signalAt: 1000 * H, blockCreatedAt: 800 * H });
  assert.equal(geo.pass, true);
  assert.equal(geo.blockAgeH, 200);
  assert.equal(entryFilterWithOi(geo, "long", 1.4).pass, true);
  assert.equal(entryFilterWithOi(geo, "short", 2.5).pass, true); // shorts: no OI condition
});

test("entry filter: each failing condition gives its reason", () => {
  assert.equal(entryFilterGeometry({ riskPct: 5, signalAt: 1000 * H, blockCreatedAt: 900 * H }).reason, "risk_below_7pct");
  assert.equal(entryFilterGeometry({ riskPct: 9, signalAt: 1000 * H, blockCreatedAt: 600 * H }).reason, "block_older_300h");
  assert.equal(entryFilterGeometry({ riskPct: 9, signalAt: 1000 * H, blockTime: 650 * H }).reason, "block_older_300h");
  assert.equal(entryFilterGeometry({ riskPct: 9, signalAt: 1000 * H }).reason, "block_age_unknown");
  const geo = entryFilterGeometry({ riskPct: 9, signalAt: 1000 * H, blockCreatedAt: 900 * H });
  assert.equal(entryFilterWithOi(geo, "long", 0.5).reason, "oi_4h_below_1pct");
  assert.equal(entryFilterWithOi(geo, "short", null).pass, true);
  assert.equal(entryFilterWithOi(geo, "long", null).reason, "oi_unknown");
});

test("CHoCH bar metrics in ATR, mirrored for shorts", () => {
  const bar = { t: 0, o: 100, h: 104, l: 99, c: 103 } as never;
  const l = chochBarMetrics(bar, 2, "long")!;
  assert.equal(l.rangeAtr, 2.5);
  assert.equal(l.bodyAtr, 1.5);
  assert.equal(l.closePos, 0.8);
  const s = chochBarMetrics(bar, 2, "short")!;
  assert.equal(s.bodyAtr, -1.5);
  assert.equal(s.closePos, 0.2);
});
