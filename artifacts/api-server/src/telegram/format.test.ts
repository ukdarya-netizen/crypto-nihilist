import assert from "node:assert/strict";
import test from "node:test";
import { formatEvent, type SignalForText } from "./format";

const s: SignalForText = {
  symbol: "JCT-USDT", setup: "4h_30m_long", htf: "4h", ltf: "30m", side: "long",
  entry: 0.001871, stop: 0.001752, tp1: 0.002324, block_top: 0.001822, block_bottom: 0.001711,
  block_scope: "internal", opened_at: "2026-10-19T01:30:00Z", targets_source: "structure",
};

test("opened: entry, stop, TP1 with 50%, trailing rule, hashtags; plain text", () => {
  const text = formatEvent(s, { kind: "opened", price: s.entry, detail: {}, created_at: s.opened_at });
  assert.match(text, /NIHILYST · JCT LONG/);
  assert.match(text, /Order block 4h → change of character 30m/);
  assert.match(text, /TP 1: 0\.002324 \(\+24\.2%\) — close 50%/);
  assert.match(text, /Take profit: \+10% — the whole position is closed/);
  assert.match(text, /#JCT #nh_4h_30m_long/);
  assert.doesNotMatch(text, /<[a-z]/i);
});

test("milestone and close texts follow the AltBullet layout", () => {
  const m = formatEvent(s, { kind: "milestone", price: 0.0020581, detail: { milestone: 10, currentStop: 0.001871, peakPct: 12 }, created_at: "2026-10-20T05:30:00Z" });
  assert.match(m, /^📊 POSITION UPDATE — JCT LONG\n🚀 \+10\.0%/);
  assert.match(m, /\| 1d 4h/);
  assert.match(m, /Stop at break-even: 0\.001871/);
  const c = formatEvent(s, { kind: "closed", price: 0.00268, detail: { reason: "trailing", peakPct: 53.2, tp1Hit: true, pnlPct: 33.4, r: 5.2 }, created_at: "2026-10-21T09:30:00Z" });
  assert.match(c, /^🏁 POSITION CLOSED — JCT LONG\n🟢 PROFIT \(trailing stop\)/);
  assert.match(c, /Position peak: \+53\.2%/);
  assert.match(c, /Trade result: \+33\.4% of price after fees · 5\.20R/);
});

test("the 15% milestone includes trailing activation instead of a separate message", () => {
  const m = formatEvent(s, {
    kind: "milestone",
    price: 0.0021,
    detail: { milestone: 15, currentStop: 0.0019, peakPct: 15, trailingActivated: true },
    created_at: "2026-10-20T05:30:00Z",
  });
  assert.match(m, /^📊 POSITION UPDATE — JCT LONG\n🚀 \+15\.0%\n📈 Trailing on from \+15%:/);
});

test("opened without take profit (2026-11-02): no TP line; break-even and trailing rules stay", () => {
  const text = formatEvent({ ...s, targets_source: "trailing_only" }, { kind: "opened", price: s.entry, detail: {}, created_at: s.opened_at });
  assert.doesNotMatch(text, /TP 1/);
  assert.match(text, /Break-even: at \+5% the stop moves to entry/);
  assert.match(text, /Take profit: \+10% — the whole position is closed/);
});
