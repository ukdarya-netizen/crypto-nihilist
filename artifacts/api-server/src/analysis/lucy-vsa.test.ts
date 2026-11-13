import assert from "node:assert/strict";
import { test } from "node:test";
import { lucyVsa } from "./final-study";

const H1 = 3_600_000;
// 200 hourly bars, flat volume 100 (fut 80 + spot 20); bar 150 = huge volume, lower low, close in the upper half.
const kl = Array.from({ length: 200 }, (_, i) => ({ t: i * H1, o: 10, h: 11, l: i === 150 ? 8 : 9, c: i === 150 ? 10.8 : 10, v: 1 }));
const fut = new Map(kl.map((k, i) => [k.t, i === 150 ? 2000 : 80 + (i % 3)]));
const spot = new Map(kl.map((k, i) => [k.t, i === 150 ? 500 : 20]));

test("Lucy's VSA: bright bar with a lower low and an upper-half close is BUY; after-entry counts", () => {
  const atEntry = lucyVsa(kl, fut, spot, H1, 151 * H1, "1h"); // last closed bar = 150
  assert.equal(atEntry.lv_1h, "ok");
  assert.equal(atEntry.lv_1h_agg, "W");
  assert.equal(atEntry.lv_1h_mark, "BUY");
  assert.equal(atEntry.lv_1h_last_buy_ago, 0);
  const before = lucyVsa(kl, fut, spot, H1, 147 * H1, "1h"); // entry at bar 146: BUY comes 4 bars after it
  assert.equal(before.lv_1h_first_buy_after, 4);
  assert.equal(before.lv_1h_a6_buy, 1);
  assert.equal(before.lv_1h_a3_buy, 0);
});

test("Lucy's VSA: a bar below the 120-bar average is grey; no futures = missing", () => {
  const v = new Map(kl.map((k, i) => [k.t, i >= 140 ? 10 : 100]));
  const r = lucyVsa(kl, v, null, H1, 146 * H1, "1h");
  assert.equal(r.lv_1h_agg, "N");
  assert.equal(lucyVsa(kl, null, spot, H1, 146 * H1, "1h").lv_1h, "missing");
});

test("Lucy's VSA v2: 20-bar extreme + next-bar confirmation, known only at the confirming bar", () => {
  const atVolumeBar = lucyVsa(kl, fut, spot, H1, 151 * H1, "1h"); // last closed = 150 (the volume bar)
  assert.equal(atVolumeBar.lv2_1h_mark, "");
  assert.equal(atVolumeBar.lv2_1h_first_buy_after, 1);
  const atConfirm = lucyVsa(kl, fut, spot, H1, 152 * H1, "1h"); // last closed = 151 confirms
  assert.equal(atConfirm.lv2_1h_mark, "BUY");
  assert.equal(atConfirm.lv_1h_last_buy_ago, 1);
});
