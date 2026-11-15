import { test } from "node:test";
import assert from "node:assert/strict";
import { decideShortUptrend, shortUptrend, trend4h } from "./short-uptrend";

const H = 3_600_000, H4 = 4 * H;

test("short uptrend (owner 2026-11-15): above the 4h cloud AND (ADX 4h ≥ 25 OR a buyer on 1h in 6 h) blocks a short", () => {
  assert.equal(decideShortUptrend(true, 30, null), true);
  assert.equal(decideShortUptrend(true, 10, true), true);
  assert.equal(decideShortUptrend(true, 10, false), false);
  assert.equal(decideShortUptrend(false, 40, true), false);   // under / in the cloud: never blocked
  assert.equal(decideShortUptrend(null, 40, true), false);    // not measurable: not blocked
});

test("a steady 4h rise reads above the cloud with a strong ADX; a quiet range does not", () => {
  const up = Array.from({ length: 200 }, (_, i) => { const b = 100 + i; return { t: i * H4, o: b, h: b + 1.2, l: b - 0.3, c: b + 1, v: 0 }; });
  const r = trend4h(up as never, { signalAt: 200 * H4, entry: 300 });
  assert.equal(r.aboveCloud, true); assert.ok((r.adx ?? 0) >= 25);
});

test("above the cloud with a weak ADX: the 1h volume decides (fetched only then)", async () => {
  // 4h: up above the cloud but choppy (weak ADX)
  const c4 = Array.from({ length: 200 }, (_, i) => { const b = 100 + i * 0.15 + (i % 2 ? 1.5 : -1.5); return { t: i * H4, o: b, h: b + 2, l: b - 2, c: b + (i % 2 ? -0.5 : 0.5), v: 0 }; });
  const s = { signalAt: 200 * H4, entry: 140, side: "short" } as never;
  const t = trend4h(c4 as never, s);
  assert.equal(t.aboveCloud, true); assert.ok((t.adx ?? 99) < 25);
  const c1 = Array.from({ length: 200 * 4 }, (_, i) => ({ t: i * H, o: 100, h: 101, l: 99, c: i === 797 ? 100.8 : 100, v: 0 }));
  const vol = (bright: boolean) => async () => ({ fut: new Map(c1.map((c, i) => [c.t, bright && i === 797 ? 5000 : 100 + (i % 3)] as [number, number])), spot: null });
  assert.equal((await shortUptrend("X-USDT", s, c4 as never, c1 as never, vol(true))).block, true);
  assert.equal((await shortUptrend("X-USDT", s, c4 as never, c1 as never, vol(false))).block, false);
});
