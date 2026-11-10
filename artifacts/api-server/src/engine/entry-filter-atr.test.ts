import assert from "node:assert/strict";
import test from "node:test";
import { entryFilter } from "./config";

test("owner 2026-11-10: longs need ATR(14) 1H ≥ 1.9% (unknown ATR not rejected; shorts unfiltered)", () => {
  const base = { side: "long" as const, riskPct: 8, entry: 100, blockTop: 99, blockBottom: 94, signalAt: Date.UTC(2026, 10, 10), blockCreatedAt: Date.UTC(2026, 10, 5) };
  assert.equal(entryFilter({ ...base, atrPct1h: 1.5 }).pass, false);
  assert.match(entryFilter({ ...base, atrPct1h: 1.5 }).reason ?? "", /atr1h_below/);
  assert.equal(entryFilter({ ...base, atrPct1h: 1.9 }).pass, true);
  assert.equal(entryFilter({ ...base, atrPct1h: null }).pass, true);
  assert.equal(entryFilter({ ...base, side: "short", atrPct1h: 0.5 }).pass, true);
});
