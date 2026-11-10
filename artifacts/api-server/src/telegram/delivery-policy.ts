/** A new signal older than this is not sent: the entry has passed (unchanged). */
export const MAX_AUTO_DELIVERY_AGE_MS = 15 * 60 * 1000;
/**
 * Owner 2026-11-10: position updates and closes are still sent up to 6 h late — before, a late tracker pass
 * (CoinGlass queue, restart) dropped them for good, and subscribers never learned that a trade closed.
 */
export const MAX_UPDATE_DELIVERY_AGE_MS = 6 * 60 * 60 * 1000;
export const maxDeliveryAgeMs = (kind: string | null | undefined) => (!kind || kind === "opened" ? MAX_AUTO_DELIVERY_AGE_MS : MAX_UPDATE_DELIVERY_AGE_MS);

export type DeliveryRecipient = { chat: string; isChannel: boolean };

type EventForDelivery = { signalLive: boolean; createdAt: Date | number | string; kind?: string | null };

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
  if (!Number.isFinite(createdAt) || age < 0 || age > maxDeliveryAgeMs(event.kind)) {
    return { action: "skip_stale" };
  }

  return { action: "enqueue", recipients };
}
