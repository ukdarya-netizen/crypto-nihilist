/**
 * Signal snapshots (as AltBullet): one immutable row per signal with every
 * technical metric at signal time, plus the market at close. Live signals
 * are captured when they open; older signals (and closes) are filled by a
 * background backfill from stored candles and marked `reconstructed`.
 * The table creates itself (no schema push needed).
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { book } from "../market/candleStore";
import {
  SNAPSHOT_VERSION, closeContext, coversAsOf, signalSnapshot, type Metrics, type SignalLike,
} from "../engine/metrics";

const BTC = "BTC-USDT";
let ensured: Promise<void> | null = null;

export function ensureSnapshotTable(): Promise<void> {
  ensured ??= pool.query(`
    CREATE TABLE IF NOT EXISTS nh_signal_snapshots (
      signal_id integer PRIMARY KEY,
      version text NOT NULL,
      status text NOT NULL DEFAULT 'ready',
      reconstructed boolean NOT NULL DEFAULT false,
      metrics jsonb,
      captured_at timestamptz NOT NULL DEFAULT now(),
      close_context jsonb,
      close_reconstructed boolean,
      close_captured_at timestamptz
    )`).then(() => undefined).catch((err) => { ensured = null; throw err; });
  return ensured;
}

type SignalRow = {
  id: number; symbol: string; side: "long" | "short"; htf: string; ltf: string; entry: number; stop: number; tp1: number;
  risk_pct: number; rr1: number; block_top: number; block_bottom: number; block_scope: string; targets_source: string;
  opened_at: Date; closed_at: Date | null; details: Record<string, unknown>;
};

export function signalLikeFromRow(row: SignalRow): SignalLike {
  const d = row.details ?? {};
  const n = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    symbol: row.symbol, side: row.side, htf: row.htf, ltf: row.ltf,
    entry: Number(row.entry), stop: Number(row.stop), tp1: Number(row.tp1),
    riskPct: Number(row.risk_pct), rr1: Number(row.rr1),
    blockTop: Number(row.block_top), blockBottom: Number(row.block_bottom), blockScope: row.block_scope,
    blockTime: n(d.blockTime), blockCreatedAt: n(d.blockCreatedAt),
    firstTouchAt: n(d.firstTouchAt), lastTouchAt: n(d.lastTouchAt),
    htfSwingTrend: n(d.htfSwingTrend), htfInternalTrend: n(d.htfInternalTrend), ltfAtr: n(d.ltfAtr),
    targetsSource: row.targets_source, signalAt: new Date(row.opened_at).getTime(),
  };
}

async function write(signalId: number, status: string, reconstructed: boolean, metrics: Metrics | null): Promise<void> {
  await ensureSnapshotTable();
  await pool.query(
    `INSERT INTO nh_signal_snapshots (signal_id, version, status, reconstructed, metrics)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (signal_id) DO NOTHING`,
    [signalId, SNAPSHOT_VERSION, status, reconstructed, metrics ? JSON.stringify(metrics) : null],
  );
}

/** Live capture at signal time. Never throws: a snapshot must not block a signal. */
export async function captureSnapshot(signalId: number, sig: SignalLike): Promise<void> {
  try {
    const btc = sig.symbol === BTC ? null : book(BTC);
    await write(signalId, "ready", false, signalSnapshot(sig, book(sig.symbol), btc));
  } catch (err) {
    logger.warn({ err, signalId }, "nihilist: snapshot capture failed (backfill will retry)");
  }
}

/** One backfill pass: missing entry snapshots, then missing close contexts. */
export async function backfillSnapshots(limit = 300): Promise<{ entries: number; closes: number; unavailable: number }> {
  await ensureSnapshotTable();
  let entries = 0; let closes = 0; let unavailable = 0;
  const { rows } = await pool.query<SignalRow>(
    `SELECT s.id, s.symbol, s.side, s.htf, s.ltf, s.entry, s.stop, s.tp1, s.risk_pct, s.rr1, s.block_top, s.block_bottom,
            s.block_scope, s.targets_source, s.opened_at, s.closed_at, s.details
     FROM nh_signals s LEFT JOIN nh_signal_snapshots n ON n.signal_id = s.id
     WHERE n.signal_id IS NULL ORDER BY s.id DESC LIMIT $1`, [limit],
  );
  for (const row of rows) {
    const sig = signalLikeFromRow(row);
    const coin = book(row.symbol);
    if (coversAsOf(coin, sig.signalAt)) {
      const btc = row.symbol === BTC ? null : book(BTC);
      await write(row.id, "ready", true, signalSnapshot(sig, coin, btc && coversAsOf(btc, sig.signalAt) ? btc : null));
      entries += 1;
    } else if (coin["30m"].length >= 200 && coin["30m"][0].t > sig.signalAt) {
      // History is loaded but starts after the signal: it can never be rebuilt.
      await write(row.id, "unavailable", true, null);
      unavailable += 1;
    }
  }
  const closed = await pool.query<SignalRow & { reconstructed_entry: boolean }>(
    `SELECT s.id, s.symbol, s.closed_at FROM nh_signals s JOIN nh_signal_snapshots n ON n.signal_id = s.id
     WHERE s.status = 'closed' AND s.closed_at IS NOT NULL AND n.close_context IS NULL
     ORDER BY s.id DESC LIMIT $1`, [limit],
  );
  for (const row of closed.rows) {
    const at = new Date(row.closed_at as Date).getTime();
    const coin = book(row.symbol);
    if (!coversAsOf(coin, at)) continue;
    const btc = row.symbol === BTC ? null : book(BTC);
    const late = Date.now() - at > 60 * 60_000;
    await pool.query(
      `UPDATE nh_signal_snapshots SET close_context = $2, close_reconstructed = $3, close_captured_at = now()
       WHERE signal_id = $1 AND close_context IS NULL`,
      [row.id, JSON.stringify(closeContext(coin, btc && coversAsOf(btc, at) ? btc : null, at)), late],
    );
    closes += 1;
  }
  return { entries, closes, unavailable };
}

export function startSnapshotBackfill(): void {
  const run = () => void backfillSnapshots().then((r) => {
    if (r.entries || r.closes || r.unavailable) logger.info(r, "nihilist: snapshot backfill");
  }).catch((err) => logger.warn({ err }, "nihilist: snapshot backfill failed"));
  setTimeout(run, 30_000).unref?.();
  setInterval(run, 5 * 60_000).unref?.();
}
