import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateChecks } from "../engine/config";
import { FILTER_SETS, atr30PctAt } from "./strategy-report";

test("candidate checks: thresholds per side, unknown fails, depth only for longs", () => {
  assert.deepEqual(candidateChecks({ side: "long", atr30Pct: 1.3, displacementAtr: 0.9, penetrationPct: 23 }), { atr: true, disp: true, pen: true });
  assert.deepEqual(candidateChecks({ side: "long", atr30Pct: 1.29, displacementAtr: 0.89, penetrationPct: 22.9 }), { atr: false, disp: false, pen: false });
  assert.deepEqual(candidateChecks({ side: "short", atr30Pct: 1.0, displacementAtr: null, penetrationPct: 0 }), { atr: true, disp: false, pen: true });
  assert.equal(candidateChecks({ side: "long", atr30Pct: null, displacementAtr: 2, penetrationPct: 50 }).atr, false);
});

test("filter sets: new filters sit on top of today's filter; shorts have none today", () => {
  const all = { atr: true, disp: true, pen: true };
  const ids = (side: "long" | "short", today: boolean, c = all) => FILTER_SETS.filter((f) => f.side === side && f.test(today, c)).map((f) => f.id);
  assert.deepEqual(ids("long", false), ["long_any", "long_new3"]);
  assert.deepEqual(ids("long", true), ["long_any", "long_today", "long_atr", "long_disp", "long_pen", "long_all3", "long_new3"]);
  assert.deepEqual(ids("long", true, { atr: false, disp: true, pen: true }), ["long_any", "long_today", "long_disp", "long_pen"]);
  assert.deepEqual(ids("short", false, { atr: true, disp: false, pen: true }), ["short_any", "short_atr"]);
});

test("ATR 30m % uses only bars closed by the signal", () => {
  const span = 30 * 60_000;
  const cs = Array.from({ length: 60 }, (_, i) => ({ t: i * span, o: 100, h: i < 40 ? 101 : 110, l: i < 40 ? 99 : 90, c: 100 }));
  const before = atr30PctAt(cs, 40 * span)!;
  assert.ok(Math.abs(before - 2) < 1e-9, String(before)); // ranges of 2 on a price of 100
  assert.ok(atr30PctAt(cs, 60 * span)! > before);
});
