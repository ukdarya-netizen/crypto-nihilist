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

test("live trade list: one row per trade with both results and the rules, newest first", async () => {
  const { liveTradeRows } = await import("./strategy-report");
  const span = 30 * 60_000;
  const mk = (id: string, openedAt: number, lows: number[]) => ({
    trade: { id, side: "long" as const, entry: 100, stop: 90, openedAt, maxHoldMs: 7 * 86_400_000 },
    group: [], sets: [], candles: lows.map((l, i) => ({ t: openedAt + i * span, o: 100, h: l === 80 ? 100 : 106, l, c: 100 })),
    row: { symbol: "AUSDT", side: "long" as const, setup: "4h_30m_long", openedAt: new Date(openedAt).toISOString(), today: true, smc: ok },
  });
  const rows = liveTradeRows([mk("a", 0, [80]), mk("b", 10 * span, [99, 99])] as never);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.openedAt, new Date(10 * span).toISOString());
  assert.equal(rows[1]!.source.reason, "stop");
  assert.equal(rows[1]!.take5.reason, "stop");
  assert.ok(rows[1]!.source.pnlPct < -9);
  assert.equal(rows[0]!.take5.reason, "take");
  assert.deepEqual(rows[0]!.smc, ok);
});
