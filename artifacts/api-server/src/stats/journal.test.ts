import assert from "node:assert/strict";
import test from "node:test";
import { buildJournal, tradeStatus, type JournalRow } from "./journal";

const row = (o: Partial<JournalRow>): JournalRow => ({
  id: 1, symbol: "X-USDT", setup: "4h_30m_long", side: "long", status: "closed", live: true,
  close_reason: "stop", pnl_pct: -3, r_multiple: -1, peak_pct: 1, mfe_pct: 1,
  opened_at: "2026-10-20T00:00:00Z", closed_at: "2026-10-21T00:00:00Z", ...o,
});

test("statuses and CAB win rate: (profit + BE) / (profit + BE + stop)", () => {
  const rows = [
    row({ id: 1, close_reason: "trailing", pnl_pct: 20, r_multiple: 4, peak_pct: 32 }),
    row({ id: 2, close_reason: "breakeven", pnl_pct: 3.9, r_multiple: 0.8, peak_pct: 9 }),
    row({ id: 3, close_reason: "breakeven", pnl_pct: 6, r_multiple: 1.2, peak_pct: 12 }),
    row({ id: 4, close_reason: "stop" }),
    row({ id: 5, close_reason: "timeout", pnl_pct: -0.5, r_multiple: -0.1, peak_pct: 3 }),
    row({ id: 6, status: "open", close_reason: null, pnl_pct: null }),
  ];
  assert.equal(tradeStatus(rows[4]), "expired");
  const { summary } = buildJournal(rows);
  assert.equal(summary.profit, 1);
  assert.equal(summary.beStop, 2);
  assert.equal(summary.stopLoss, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.winRate, 75);
  assert.deepEqual(summary.beBuckets, { lt5: 0, after5: 0, after8: 1, after10: 1 });
  assert.equal(summary.open, 1);
  assert.equal(summary.netPnlPct, 26.4);
  assert.equal(summary.bestTrade?.id, 1);
  assert.equal(summary.reached.p10, 2);
});
