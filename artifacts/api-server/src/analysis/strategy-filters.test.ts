import assert from "node:assert/strict";
import { test } from "node:test";
import type { SmcChecks } from "../engine/setups";
import { FILTER_SETS } from "./strategy-report";

const ok: SmcChecks = { trendSwing: true, trendInternal: true, discount: true, sweep: true, fvg: true, fresh: true };
const ids = (side: "long" | "short", today: boolean, c: SmcChecks | null) =>
  FILTER_SETS.filter((f) => f.side === side && f.test(today, c)).map((f) => f.id);

test("SMC sets: longs on all and on today's filter, shorts on all; unknown fails", () => {
  assert.equal(ids("long", true, ok).length, 16);
  assert.equal(ids("short", false, ok).length, 8);
  assert.deepEqual(ids("long", false, ok).filter((x) => x.startsWith("long_today")), []);
  assert.deepEqual(ids("long", false, null), ["long_any"]);
  assert.deepEqual(ids("long", true, null), ["long_any", "long_today"]);
  assert.deepEqual(ids("short", false, { ...ok, fvg: null }).includes("short_any_fvg"), false);
});

test("«все SMC» needs swing trend, zone, sweep, FVG and a fresh block — not the internal trend", () => {
  assert.ok(ids("long", false, { ...ok, trendInternal: false }).includes("long_any_all"));
  for (const k of ["trendSwing", "discount", "sweep", "fvg", "fresh"] as const) {
    assert.ok(!ids("long", false, { ...ok, [k]: false }).includes("long_any_all"), k);
  }
});
