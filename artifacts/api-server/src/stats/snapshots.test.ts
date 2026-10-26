import assert from "node:assert/strict";
import test from "node:test";
import {
  logSnapshotBackfillFailure, logSnapshotBackfillResult, runSnapshotBackfillRows, runSnapshotBackfillStage, selectTrajectoryDue,
} from "./snapshots";

test("snapshot backfill continues after a row failure and logs its stage and signal id", async () => {
  const records: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const target = {
    error: (fields: Record<string, unknown>, message: string) => records.push({ fields, message }),
    info: () => assert.fail("row failure must not be logged as success"),
  };
  const handled: number[] = [];
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

  await runSnapshotBackfillRows("entry", rows, (row) => row.id, async (row) => {
    if (row.id === 2) throw Object.assign(new Error("insert failed"), { code: "23505" });
    handled.push(row.id);
  }, target);

  assert.deepEqual(handled, [1, 3]);
  assert.equal(records.length, 1);
  assert.equal(records[0].message, "nihilist: snapshot backfill record failed");
  assert.equal(records[0].fields.stage, "entry");
  assert.equal(records[0].fields.signalId, 2);
  const loggedError = records[0].fields.err as { code: string; type: string; message: string; stack: string };
  assert.equal(loggedError.code, "23505");
  assert.equal(loggedError.type, "Error");
  assert.equal(loggedError.message, "insert failed");
  assert.match(loggedError.stack, /Error: insert failed/);
});

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

test("snapshot backfill failures keep the original err and identify each failing stage", async () => {
  const stages = ["entry", "close", "derivs", "trajectory"] as const;

  for (const stage of stages) {
    const original = Object.assign(new Error(`${stage} operation failed`), { code: `ERR_${stage}` });
    const records: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const target = {
      error: (fields: Record<string, unknown>, message: string) => records.push({ fields, message }),
      info: () => assert.fail("failure must not be logged as success"),
    };

    await assert.rejects(
      runSnapshotBackfillStage(stage, async () => { throw original; }),
      (err: unknown) => {
        logSnapshotBackfillFailure(err, "nihilist: snapshot backfill failed", target);
        return true;
      },
    );

    assert.equal(records.length, 1);
    assert.equal(records[0].fields.stage, stage);
    assert.deepEqual(records[0].fields.err, {
      code: `ERR_${stage}`,
      type: "Error",
      message: `${stage} operation failed`,
      stack: original.stack,
    });
    assert.equal(records[0].message, "nihilist: snapshot backfill failed");
  }
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

test("trajectory history advances on every pass while live points keep arriving", () => {
  const now = 10_000_000;
  const limit = 10;
  let history = Array.from({ length: 60 }, (_, i) => ({
    row: { id: i + 1 },
    at: now - 60 * 60_000 - i * 60_000,
    value: `history-${i + 1}`,
  }));
  let liveQueue: Array<{ row: { id: number }; at: number; value: string }> = [];
  let historicalSaved = 0;
  let liveSaved = 0;

  for (let pass = 0; pass < 10; pass++) {
    const incomingLive = Array.from({ length: 50 }, (_, i) => ({
      row: { id: 1000 + pass * 50 + i },
      at: now - 1_000 - i,
      value: `live-${pass}-${i}`,
    }));
    liveQueue.push(...incomingLive);
    const picked = selectTrajectoryDue([...liveQueue, ...history], limit, now);
    const savedHistory = picked.filter((point) => point.value.startsWith("history-"));
    const savedLive = picked.filter((point) => point.value.startsWith("live-"));

    assert.equal(picked.length, limit);
    assert.ok(savedHistory.length >= 5, "each pass must reserve capacity for old trajectory points");
    assert.ok(savedLive.length > 0, "recent points must still be processed");
    assert.deepEqual(
      savedHistory.map((point) => point.row.id),
      [...savedHistory.map((point) => point.row.id)].sort((a, b) => a - b),
      "history should proceed from the oldest signal",
    );
    historicalSaved += savedHistory.length;
    liveSaved += savedLive.length;
    const savedHistoryValues = new Set(savedHistory.map((point) => point.value));
    const savedLiveValues = new Set(savedLive.map((point) => point.value));
    history = history.filter((point) => !savedHistoryValues.has(point.value));
    liveQueue = liveQueue.filter((point) => !savedLiveValues.has(point.value));
  }

  assert.equal(historicalSaved, 50, "history must make measurable progress despite a continuous live stream");
  assert.equal(liveSaved, 50);
});
