import assert from "node:assert/strict";
import test from "node:test";
import { vsaFeatures } from "./vsa";

// 40 flat bars (range 2, volume 100), a capitulation low at 30 on volume 300 that closes at its high,
// a quiet retest at 32, then the break bar at 39 on volume 250.
const bars = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100, v: 100 }));
bars[30] = { t: 30, o: 99, h: 99, l: 90, c: 98.9, v: 300 };
bars[32] = { t: 32, o: 95, h: 95.5, l: 91, c: 95.2, v: 50 };
bars[39] = { t: 39, o: 100, h: 104, l: 99.5, c: 104, v: 250 };

test("VSA features: extreme volume and close, low-volume test, break-bar volume", () => {
  const m = vsaFeatures(bars, 39, 25);
  assert.equal(m.vsa_window_bars, 14);
  assert.equal(m.vsa_ext_vol_rel, 3);           // 300 / avg 100
  assert.ok((m.vsa_ext_close_pos ?? 0) > 0.98);  // closed at the high of the low bar
  assert.equal(m.vsa_test_low_vol, 1);          // bar 32: within 0.5 ATR of the low on half volume
  assert.ok((m.vsa_choch_vol_rel ?? 0) > 2);
  assert.ok((m.vsa_max_vol_rel ?? 0) >= 3);
});
