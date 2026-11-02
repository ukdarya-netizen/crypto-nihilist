import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFilter } from "./config";
import { chochBarMetrics } from "./choch-bar";
import { adxDi } from "./metrics";

const H = 3_600_000;
const base = { entry: 100, blockTop: 96, blockBottom: 90, signalAt: 1000 * H, blockCreatedAt: 800 * H };

test("long passes: stop >= 7%, block <= 300h, block >= 4% of price", () => {
  const r = entryFilter({ ...base, side: "long", riskPct: 7.2 });
  assert.equal(r.pass, true);
  assert.equal(r.blockAgeH, 200);
  assert.equal(r.blockSizePct, 6);
});

test("long rejected with every failing reason", () => {
  assert.equal(entryFilter({ ...base, side: "long", riskPct: 5 }).reason, "risk_below_7pct");
  assert.equal(entryFilter({ ...base, side: "long", riskPct: 9, blockCreatedAt: 600 * H }).reason, "block_older_300h");
  assert.equal(entryFilter({ ...base, side: "long", riskPct: 9, blockCreatedAt: null, blockTime: 650 * H }).reason, "block_older_300h");
  assert.equal(entryFilter({ ...base, side: "long", riskPct: 9, blockCreatedAt: null }).reason, "block_age_unknown");
  assert.equal(entryFilter({ ...base, side: "long", riskPct: 9, blockBottom: 93 }).reason, "block_below_4pct");
});

test("shorts are not filtered", () => {
  assert.equal(entryFilter({ ...base, side: "short", riskPct: 3, blockCreatedAt: 100 * H, blockBottom: 95.5 }).pass, true);
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

test("ADX/DI: steady uptrend has +DI above -DI and high ADX", () => {
  const up = Array.from({ length: 80 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const x = adxDi(up);
  assert.ok((x.adx ?? 0) > 90);
  assert.ok((x.pdi ?? 0) > (x.mdi ?? 0));
});
