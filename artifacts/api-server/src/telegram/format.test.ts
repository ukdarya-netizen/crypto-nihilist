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
  assert.match(text, /NIHILYST · JCT ЛОНГ/);
  assert.match(text, /Ордер-блок 4h → слом структуры 30m/);
  assert.match(text, /Тейк 1: 0\.002324 \(\+24\.2%\) — фиксируем 50%/);
  assert.match(text, /Трейлинг: с \+15%/);
  assert.match(text, /#JCT #nh_4h_30m_long/);
  assert.doesNotMatch(text, /<[a-z]/i);
});

test("milestone and close texts follow the AltBullet layout", () => {
  const m = formatEvent(s, { kind: "milestone", price: 0.0020581, detail: { milestone: 10, currentStop: 0.001871, peakPct: 12 }, created_at: "2026-10-20T05:30:00Z" });
  assert.match(m, /^📊 POSITION UPDATE — JCT ЛОНГ\n🚀 \+10\.0%/);
  assert.match(m, /\| 1д 4ч/);
  assert.match(m, /Стоп в безубытке: 0\.001871/);
  const c = formatEvent(s, { kind: "closed", price: 0.00268, detail: { reason: "trailing", peakPct: 53.2, tp1Hit: true, pnlPct: 33.4, r: 5.2 }, created_at: "2026-10-21T09:30:00Z" });
  assert.match(c, /^🏁 POSITION CLOSED — JCT ЛОНГ\n🟢 PROFIT \(трейлинг\)/);
  assert.match(c, /Пик позиции: \+53\.2%/);
  assert.match(c, /Итог сделки: \+33\.4% цены с комиссиями · 5\.20R/);
});
