import assert from "node:assert/strict";
import test from "node:test";
import { MAX_AUTO_DELIVERY_AGE_MS, MAX_UPDATE_DELIVERY_AGE_MS, planEventDelivery, type DeliveryRecipient } from "./delivery-policy";

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

test("a late close or position update is still sent (up to 6 h); a late new signal is not", () => {
  const late = now - 40 * 60_000;
  assert.deepEqual(planEventDelivery({ signalLive: true, createdAt: late, kind: "closed" }, [channel], now), { action: "enqueue", recipients: [channel] });
  assert.deepEqual(planEventDelivery({ signalLive: true, createdAt: late, kind: "milestone" }, [channel], now), { action: "enqueue", recipients: [channel] });
  assert.deepEqual(planEventDelivery({ signalLive: true, createdAt: late, kind: "opened" }, [channel], now), { action: "skip_stale" });
  assert.deepEqual(planEventDelivery({ signalLive: true, createdAt: now - MAX_UPDATE_DELIVERY_AGE_MS - 1, kind: "closed" }, [channel], now), { action: "skip_stale" });
});
