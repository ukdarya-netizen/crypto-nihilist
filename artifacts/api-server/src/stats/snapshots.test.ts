import assert from "node:assert/strict";
import test from "node:test";
import {
  logSnapshotBackfillFailure, logSnapshotBackfillResult,
} from "./snapshots";

test("snapshot backfill failures log full structured err at error level", () => {
  const cause = new Error("connection refused");
  const err = Object.assign(new Error("snapshot insert failed", { cause }), {
    code: "23505",
    detail: "signal_id already exists",
  });
  const records: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const target = {
    error: (fields: Record<string, unknown>, message: string) => records.push({ level: "error", fields, message }),
    info: () => assert.fail("failure must not be logged as success"),
  };

  logSnapshotBackfillFailure(err, "nihilist: snapshot backfill failed", target);

  assert.equal(records.length, 1);
  assert.equal(records[0].level, "error");
  assert.equal(records[0].message, "nihilist: snapshot backfill failed");
  assert.deepEqual(records[0].fields.err, {
    code: "23505",
    detail: "signal_id already exists",
    type: "Error",
    message: "snapshot insert failed",
    stack: err.stack,
    cause: {
      type: "Error",
      message: "connection refused",
      stack: cause.stack,
    },
  });
});

test("successful snapshot backfill stays an info record without err", () => {
  const records: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const target = {
    error: () => assert.fail("success must not be logged as failure"),
    info: (fields: Record<string, unknown>, message: string) => records.push({ level: "info", fields, message }),
  };

  logSnapshotBackfillResult({ entries: 1, closes: 0, unavailable: 0, derivs: 0, trajectory: 0 }, target);

  assert.deepEqual(records, [{
    level: "info",
    fields: { entries: 1, closes: 0, unavailable: 0, derivs: 0, trajectory: 0 },
    message: "nihilist: snapshot backfill",
  }]);
});
