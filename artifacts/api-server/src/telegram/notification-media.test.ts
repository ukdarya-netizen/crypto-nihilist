import assert from "node:assert/strict";
import test from "node:test";
import { notificationPhotoKind } from "./notification-media";

test("notification photo matches each Telegram event category", () => {
  assert.equal(notificationPhotoKind("opened", null), "signal");
  assert.equal(notificationPhotoKind("closed", "stop"), "stopLoss");
  assert.equal(notificationPhotoKind("tp1", null), "takeProfit");
  assert.equal(notificationPhotoKind("closed", "trailing"), "takeProfit");
  assert.equal(notificationPhotoKind("milestone", null), "positionUpdate");
  assert.equal(notificationPhotoKind("breakeven", null), "positionUpdate");
  assert.equal(notificationPhotoKind("trailing_on", null), "positionUpdate");
  assert.equal(notificationPhotoKind("closed", "breakeven"), null);
  assert.equal(notificationPhotoKind("closed", "timeout"), null);
  assert.equal(notificationPhotoKind(null, null), null);
});
