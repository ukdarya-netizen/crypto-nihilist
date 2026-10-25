import assert from "node:assert/strict";
import test from "node:test";
import { MAX_AUTO_DELIVERY_AGE_MS, planEventDelivery, type DeliveryRecipient } from "./delivery-policy";

const now = Date.parse("2026-10-25T14:00:00Z");
const channel: DeliveryRecipient = { chat: "@nihilystcryptotrading", isChannel: true };

test("live event with no channel and no subscribers stays pending", () => {
  const plan = planEventDelivery({ signalLive: true, createdAt: now }, [], now);
  assert.deepEqual(plan, { action: "defer" });
});

test("fresh pending event can be queued after a channel becomes available", () => {
  const plan = planEventDelivery({ signalLive: true, createdAt: now - 60_000 }, [channel], now);
  assert.deepEqual(plan, { action: "enqueue", recipients: [channel] });
});

test("stale live event is not automatically replayed after a channel is configured", () => {
  const plan = planEventDelivery(
    { signalLive: true, createdAt: now - MAX_AUTO_DELIVERY_AGE_MS - 1 },
    [channel],
    now,
  );
  assert.deepEqual(plan, { action: "skip_stale" });
});

test("non-live event is suppressed without requiring a recipient", () => {
  const plan = planEventDelivery({ signalLive: false, createdAt: now }, [], now);
  assert.deepEqual(plan, { action: "mark_suppressed" });
});
