import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { tradeStatus, TRADE_STATUS_SQL, type JournalRow } from "./journal";

// The «В работе» list filters in SQL; it must match tradeStatus() exactly.
test("TRADE_STATUS_SQL matches tradeStatus()", { skip: !process.env.DATABASE_URL }, async () => {
  const cases: Array<[string, string | null, number | null]> = [
    ["open", null, null], ["open", "stop", -3], ["closed", "stop", -3], ["closed", "breakeven", 0.1],
    ["closed", "timeout", 2], ["closed", "timeout", -1], ["closed", "timeout", null], ["closed", "take", 8], ["closed", "trailing", 4],
  ];
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const [status, reason, pnl] of cases) {
      const { rows } = await pool.query(
        `SELECT ${TRADE_STATUS_SQL} AS st FROM (SELECT $1::text AS status, $2::text AS close_reason, $3::numeric AS pnl_pct) s`,
        [status, reason, pnl],
      );
      assert.equal(rows[0].st, tradeStatus({ status, close_reason: reason, pnl_pct: pnl } as unknown as JournalRow), `${status}/${reason}/${pnl}`);
    }
  } finally { await pool.end(); }
});
