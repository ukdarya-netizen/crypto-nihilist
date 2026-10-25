export const MAX_AUTO_DELIVERY_AGE_MS = 15 * 60 * 1000;

export type DeliveryRecipient = { chat: string; isChannel: boolean };

type EventForDelivery = { signalLive: boolean; createdAt: Date | number | string };

export type DeliveryPlan =
  | { action: "mark_suppressed" }
  | { action: "defer" }
  | { action: "skip_stale" }
  | { action: "enqueue"; recipients: DeliveryRecipient[] };

/**
 * Keep live events pending when there is nowhere to send them. A later channel
 * configuration may pick them up only while they are still recent, never as an
 * automatic replay of an old actionable signal.
 */
export function planEventDelivery(
  event: EventForDelivery,
  recipients: DeliveryRecipient[],
  now = Date.now(),
): DeliveryPlan {
  if (!event.signalLive) return { action: "mark_suppressed" };
  if (!recipients.length) return { action: "defer" };

  const createdAt = event.createdAt instanceof Date
    ? event.createdAt.getTime()
    : typeof event.createdAt === "string"
      ? Date.parse(event.createdAt)
      : event.createdAt;
  const age = now - createdAt;
  if (!Number.isFinite(createdAt) || age < 0 || age > MAX_AUTO_DELIVERY_AGE_MS) {
    return { action: "skip_stale" };
  }

  return { action: "enqueue", recipients };
}
