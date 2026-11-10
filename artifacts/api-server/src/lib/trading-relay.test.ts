import assert from "node:assert/strict";
import test from "node:test";
import { classifyReceipt, closeReason, decimal, signalPayload, wireSymbol } from "./trading-relay";
import { sourceAction } from "../routes/trading-sync";

test("wire format: symbol, decimals without exponent, entry signal without size or leverage", () => {
  assert.equal(wireSymbol("1000PEPE-USDT"), "1000PEPEUSDT");
  assert.equal(decimal(0.00000123456), "0.00000123456");
  assert.equal(decimal(0.000000012345), "0.000000012345");
  assert.equal(decimal(64123.456789), "64123.456789");
  const p = signalPayload({ id: 7, symbol: "ALT-USDT", side: "short", setup: "4h_30m_short", htf: "4h", entry: 0.0067, stop: 0.0072, signalAt: Date.UTC(2026, 10, 2) });
  assert.equal(p.sourceSignalId, "nh-signal-7");
  assert.equal(p.side, "short");
  assert.equal(p.stopLoss, "0.0072");
  assert.deepEqual(p.exitRules, { noFixedTakeProfit: false, closeAllAtPct: 8, breakevenAtPct: 5, trailingActivationPct: 15, trailingGapPercentagePoints: 10, maxHoldHours: 168, stopsFollowSourceCommands: true });
  for (const k of ["quantity", "leverage", "marginMode", "initialMarginUsd"]) assert.equal(k in p, false);
});

test("receipts: commands need stored=true for the same id; 400/422 quarantined; others retried", () => {
  assert.equal(classifyReceipt("signal", 202, {}, "nh-signal-1"), "delivered");
  assert.equal(classifyReceipt("signal", 409, {}, "nh-signal-1"), "delivered");
  assert.equal(classifyReceipt("command", 202, {}, "nh-1-1"), "retry");
  assert.equal(classifyReceipt("command", 202, { stored: true, commandId: "nh-1-1" }, "nh-1-1"), "delivered");
  assert.equal(classifyReceipt("command", 422, {}, "nh-1-1"), "quarantined");
  assert.equal(classifyReceipt("signal", 503, {}, "nh-signal-1"), "retry");
  assert.equal(closeReason("trailing"), "trailing_stop");
  assert.equal(closeReason("timeout"), "expired");
  assert.equal(sourceAction({ status: "open", closed_at: null }), "hold");
  assert.equal(sourceAction({ status: "closed", closed_at: new Date() }), "close");
});
