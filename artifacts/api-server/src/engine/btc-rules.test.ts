import { test } from "node:test";
import assert from "node:assert/strict";
import { BTC_TARGETS_SOURCE, btcTargets, isBtc } from "./config";
import { applyCandles, openTrade, tradeResult } from "./trade";
import { stateFromRow } from "./tracker";
import { formatEvent } from "../telegram/format";

const H = 300_000;
const c = (i: number, o: number, h: number, l: number, cl: number) => ({ t: i * H, o, h, l, c: cl });

test("BTC targets: 1.5R and 3R from the entry and the stop, both sides", () => {
  assert.ok(isBtc("BTC-USDT") && !isBtc("ETH-USDT"));
  assert.deepEqual(btcTargets("long", 100, 98), [103, 106]);
  assert.deepEqual(btcTargets("short", 100, 102), [97, 94]);
});

test("BTC trade: TP 1 closes half and moves the stop to entry, TP 2 closes the rest; no +5% break-even, no trailing", () => {
  const t = openTrade({ side: "long", entry: 100, stop: 98, tp1: 103, openedAt: 0, maxHoldMs: 7 * 86_400_000, breakevenAtPct: null, takeProfit: true, takeAtPct: null, takePrice: 106, trailing: false });
  const a = applyCandles(t, [c(0, 100, 103.2, 99.5, 103)], H);
  assert.deepEqual(a.events.map((e) => e.kind), ["tp1"]);
  assert.equal(a.state.currentStop, 100);
  const b = applyCandles(a.state, [c(1, 103, 106.5, 102, 106)], H);
  assert.equal(b.state.closeReason, "take");
  assert.equal(b.state.exitPrice, 106);
  assert.ok(Math.abs(tradeResult(b.state).pnlPct - (0.5 * 3 + 0.5 * 6 - 0.1)) < 1e-9);
  // An altcoin long would switch on trailing at +15%; BTC never does.
  const big = applyCandles(openTrade({ side: "long", entry: 100, stop: 98, tp1: 200, openedAt: 0, maxHoldMs: 7 * 86_400_000, breakevenAtPct: null, takeProfit: false, takePrice: null, trailing: false }), [c(0, 100, 120, 99, 119)], H);
  assert.equal(big.state.trailingActive, false);
});

test("an open BTC row is managed by BTC rules; an altcoin row keeps break-even +5%", () => {
  const base = { id: 1, symbol: "BTC-USDT", setup: "4h_30m_long", htf: "4h" as const, side: "long" as const, entry: 100, stop: 98, tp1: 103, tp2: 106, current_stop: 98,
    opened_at: new Date(0), expires_at: new Date(86_400_000), tp1_hit: false, tp1_at: null, breakeven_moved: false, trailing_active: false, peak_pct: 0, last_milestone: 0, mfe_pct: 0, mae_pct: 0, last_candle_time: null };
  const btc = stateFromRow({ ...base, targets_source: BTC_TARGETS_SOURCE });
  assert.equal(btc.breakevenAtPct, null); assert.equal(btc.takePrice, 106); assert.equal(btc.trailingEnabled, false); assert.equal(btc.tp1Enabled, true);
  const alt = stateFromRow({ ...base, symbol: "SOL-USDT", targets_source: "trailing_only" });
  assert.equal(alt.breakevenAtPct, 5); assert.equal(alt.takePrice, null); assert.equal(alt.trailingEnabled, true); assert.equal(alt.tp1Enabled, true);
  assert.ok(Math.abs(alt.tp1 - 110) < 1e-9); assert.equal(alt.takeAtPct, null); // owner 2026-11-10: 50% at +10%
});

test("BTC signal text: TP 1 1.5R and TP 2 3R, no +5% / +8% / +15% lines", () => {
  const s = { symbol: "BTC-USDT", setup: "4h_30m_long", htf: "4h", ltf: "30m", side: "long" as const, entry: 100000, stop: 98700, tp1: 101950, tp2: 103900,
    block_top: 99500, block_bottom: 98800, block_scope: "internal", opened_at: "2026-11-10T00:00:00Z", targets_source: BTC_TARGETS_SOURCE };
  const text = formatEvent(s, { kind: "opened", price: 100000, detail: {}, created_at: "2026-11-10T00:00:00Z" });
  assert.match(text, /TP 1: 101950\.0 \(\+1\.9%, 1\.5R\) — close 50%, stop to break-even/);
  assert.match(text, /TP 2: 103900\.0 \(\+3\.9%, 3R\) — close the rest/);
  assert.doesNotMatch(text, /\+5%|\+8%|\+15%/);
  const closed = formatEvent(s, { kind: "closed", price: 103900, detail: { reason: "take", tp1Hit: true, pnlPct: 2.8, r: 2.1, peakPct: 3.9 }, created_at: "2026-11-11T00:00:00Z" });
  assert.match(closed, /PROFIT \(TP 2 — 3R\)/);
});
