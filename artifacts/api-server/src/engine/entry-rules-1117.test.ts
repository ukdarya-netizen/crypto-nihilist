import assert from "node:assert/strict";
import { test } from "node:test";
import { widenShortStop, zoneVolume } from "./entry-rules-1117";

const H = 3_600_000;
test("short stop 2 ATR further, risk recounted; longs and unknown ATR untouched (owner 2026-11-17)", () => {
  const s = { side: "short" as const, entry: 100, stop: 108, riskPct: 8 };
  const w = widenShortStop(s, 1.5);
  assert.equal(w.riskPct, 11);
  assert.equal(Math.round(w.stop * 1000) / 1000, 111);
  assert.equal(w.stopBase, 108);
  assert.equal(widenShortStop({ ...s, side: "long" as never }, 1.5).stop, 108);
  assert.equal(widenShortStop(s, null).stop, 108);
});

test("long zone volume: a bright bar on a CLOSED 1h candle between the touch and the entry (owner 2026-11-17)", () => {
  const c1 = Array.from({ length: 200 }, (_, i) => ({ t: i * H, o: 100, h: 101, l: 99, c: 100.2, v: 1 }));
  const quiet = new Map(c1.map((c, i) => [c.t, 100 + (i % 3)] as [number, number]));
  const loud = new Map(quiet); loud.set(190 * H, 2000);
  const s = { firstTouchAt: 188 * H, signalAt: 192 * H };
  assert.equal(zoneVolume(s, c1 as never, quiet, null).pass, false);
  assert.equal(zoneVolume(s, c1 as never, loud, null).pass, true);
  // the bright bar on the candle still open at the entry does not count
  const late = new Map(quiet); late.set(192 * H, 2000);
  assert.equal(zoneVolume({ firstTouchAt: 188 * H, signalAt: 192 * H + 30 * 60_000 }, c1 as never, late, null).pass, false);
  assert.deepEqual(zoneVolume(s, c1 as never, null, null), { pass: false, bars: 0, bright: 0, volume: "missing" });
});
