/**
 * Owner 2026-10-27: one coin + one side = one signal. Signals opened before the
 * one-trade-per-coin rule (d578f6f) could duplicate a signal that was already
 * open on the same coin and side (e.g. ETHFI 4h→30m and 4h→1h). The later one
 * is the same trade, so it is removed everywhere: signal, events, Telegram
 * deliveries, snapshot, trajectory. The earliest signal (opened_at, id) stays.
 * An audit row per removed signal is kept in nh_decisions. Idempotent.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

type Row = { id: number; symbol: string; setup: string; side: string; opened_at: Date; closed_at: Date | null };
type Dup = Row & { kept_id: number; kept_setup: string };

/** In time order: a signal duplicates a KEPT signal of the same coin/side still open at its opening. */
export function findDuplicates(rows: Row[]): Dup[] {
  const sorted = [...rows].sort((a, b) => +a.opened_at - +b.opened_at || a.id - b.id);
  const kept = new Map<string, Row[]>();
  const dups: Dup[] = [];
  for (const r of sorted) {
    const key = `${r.symbol}|${r.side}`;
    const list = kept.get(key) ?? [];
    const open = list.find((k) => k.closed_at === null || +k.closed_at > +r.opened_at);
    if (open) dups.push({ ...r, kept_id: open.id, kept_setup: open.setup });
    else kept.set(key, [...list, r]);
  }
  return dups;
}

export async function removeDuplicateSignals(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const all = await client.query<Row>("SELECT id, symbol, setup, side, opened_at, closed_at FROM nh_signals");
    const rows = findDuplicates(all.rows);
    if (!rows.length) {
      await client.query("COMMIT");
      return 0;
    }
    const ids = rows.map((r) => r.id);
    for (const r of rows) {
      await client.query(
        `INSERT INTO nh_decisions (symbol, setup, bar_time, decision, reason, block_id, details)
         VALUES ($1, $2, $3, 'removed', 'duplicate_of_open_signal', $4, $5)
         ON CONFLICT DO NOTHING`,
        [r.symbol, r.setup, new Date(r.opened_at).getTime(), `dup:${r.id}`,
          JSON.stringify({ removedSignalId: r.id, keptSignalId: r.kept_id, keptSetup: r.kept_setup, side: r.side })],
      );
    }
    await client.query(
      `DELETE FROM nh_telegram_deliveries WHERE event_id IN (SELECT id FROM nh_signal_events WHERE signal_id = ANY($1))`, [ids],
    );
    await client.query("DELETE FROM nh_signal_events WHERE signal_id = ANY($1)", [ids]);
    for (const table of ["nh_signal_snapshots", "nh_signal_trajectory"]) {
      const exists = await client.query("SELECT to_regclass($1) AS t", [table]);
      if (exists.rows[0]?.t) await client.query(`DELETE FROM ${table} WHERE signal_id = ANY($1)`, [ids]);
    }
    await client.query("DELETE FROM nh_signals WHERE id = ANY($1)", [ids]);
    await client.query("COMMIT");
    logger.info({ removed: rows.map((r) => ({ id: r.id, symbol: r.symbol, setup: r.setup, kept: r.kept_id })) },
      "nihilist: duplicate signals removed");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
