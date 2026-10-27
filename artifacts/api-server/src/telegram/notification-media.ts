export type TelegramPhotoKind = "signal" | "stopLoss" | "takeProfit" | "positionUpdate";

export function notificationPhotoKind(
  eventKind: string | null,
  eventReason: string | null,
): TelegramPhotoKind | null {
  if (eventKind === "opened") return "signal";
  if (eventKind === "closed" && eventReason === "stop") return "stopLoss";
  if (eventKind === "tp1" || (eventKind === "closed" && eventReason === "trailing")) return "takeProfit";
  if (eventKind === "milestone" || eventKind === "breakeven" || eventKind === "trailing_on") {
    return "positionUpdate";
  }
  return null;
}
