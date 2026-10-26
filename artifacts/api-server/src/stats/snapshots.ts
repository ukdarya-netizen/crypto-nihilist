/**
 * Signal snapshots (as AltBullet): one immutable row per signal with every
 * metric at signal time — technical (candles) and derivatives/flow from
 * CoinGlass (OI, taker, CVD, funding, liquidations, long/short) — plus the
 * market at close, and a trajectory: the same picture at fixed points of the
 * trade (TRAJECTORY below). Live signals are captured when they open; older
 * signals, closes and due trajectory points are filled by a background
 * backfill (candles from memory, CoinGlass history with end_time = that
 * moment) and marked `reconstructed`. Tables create themselves.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { book } from "../market/candleStore";
import {
  SNAPSHOT_VERSION, closeContext, closedAsOf, coversAsOf, marketMetrics, signalSnapshot, type Metrics, type SignalLike,
} from "../engine/metrics";
import { derivativeMetrics } from "../market/derivatives";

import { trajectoryPoints } from "../engine/trajectory";
export { trajectoryPoints };

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
    );
    ALTER TABLE nh_signal_snapshots ADD COLUMN IF NOT EXISTS deriv_at timestamptz;
    ALTER TABLE nh_signal_snapshots ADD COLUMN IF NOT EXISTS close_deriv_at timestamptz;
    CREATE TABLE IF NOT EXISTS nh_signal_trajectory (
      signal_id integer NOT NULL,
      label text NOT NULL,
      at timestamptz NOT NULL,
      elapsed_ms bigint NOT NULL,
      price double precision,
      pct_from_entry double precision,
      metrics jsonb,
      reconstructed boolean NOT NULL DEFAULT false,
      captured_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (signal_id, label)
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
    ob: d.ob && typeof d.ob === "object" ? d.ob as SignalLike["ob"] : null,
    confluenceSetups: Array.isArray(d.confluenceSetups) ? d.confluenceSetups as string[] : null,
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
    // CoinGlass reads take a few seconds: never hold up the signal for them.
    void addDerivatives(signalId, sig.symbol, sig.signalAt, "entry").catch(() => undefined);
  } catch (err) {
    logger.warn({ err, signalId }, "nihilist: snapshot capture failed (backfill will retry)");
  }
}

/** Merges CoinGlass metrics at `at` into the entry snapshot or the close context. */
async function addDerivatives(signalId: number, symbol: string, at: number, which: "entry" | "close"): Promise<void> {
  const d = await derivativeMetrics(symbol, at);
  const col = which === "entry" ? "metrics" : "close_context";
  const mark = which === "entry" ? "deriv_at" : "close_deriv_at";
  await pool.query(
    `UPDATE nh_signal_snapshots SET ${col} = coalesce(${col}, '{}'::jsonb) || $2::jsonb, ${mark} = now()
     WHERE signal_id = $1`,
    [signalId, JSON.stringify(d)],
  );
}

/** Price at a moment: close of the last 30m bar closed by then. */
function priceAt(symbol: string, at: number): number | null {
  const s = closedAsOf(book(symbol)["30m"], "30m", at);
  return s.length ? s[s.length - 1].c : null;
}

/** One backfill pass: missing entry snapshots, then missing close contexts. */
export async function backfillSnapshots(limit = 300): Promise<{ entries: number; closes: number; unavailable: number; derivs: number; trajectory: number }> {
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
  // Derivatives for entry snapshots and closes (CoinGlass budget: bounded per pass).
  let derivs = 0;
  const needDeriv = await pool.query<{ signal_id: number; symbol: string; opened_at: Date; closed_at: Date | null; entry_missing: boolean }>(
    `SELECT n.signal_id, s.symbol, s.opened_at, s.closed_at, (n.deriv_at IS NULL) AS entry_missing
     FROM nh_signal_snapshots n JOIN nh_signals s ON s.id = n.signal_id
     WHERE n.status = 'ready' AND (n.deriv_at IS NULL OR (n.close_context IS NOT NULL AND n.close_deriv_at IS NULL))
     ORDER BY n.signal_id DESC LIMIT 25`,
  );
  for (const row of needDeriv.rows) {
    if (row.entry_missing) await addDerivatives(row.signal_id, row.symbol, new Date(row.opened_at).getTime(), "entry");
    else if (row.closed_at) await addDerivatives(row.signal_id, row.symbol, new Date(row.closed_at).getTime(), "close");
    derivs += 1;
  }
  const trajectory = await backfillTrajectory(200);
  return { entries, closes, unavailable, derivs, trajectory };
}

/** Due trajectory points, newest first (the live picture stays current; history fills behind). */
export async function backfillTrajectory(limit: number, now = Date.now()): Promise<number> {
  const { rows } = await pool.query<{ id: number; symbol: string; side: "long" | "short"; entry: number; opened_at: Date; closed_at: Date | null; details: Record<string, unknown>; have: string[] | null }>(
    `SELECT s.id, s.symbol, s.side, s.entry, s.opened_at, s.closed_at, s.details,
            (SELECT array_agg(t.label) FROM nh_signal_trajectory t WHERE t.signal_id = s.id) AS have
     FROM nh_signals s WHERE s.opened_at > now() - interval '40 days' ORDER BY s.id DESC LIMIT 400`,
  );
  const due: Array<{ row: (typeof rows)[number]; label: string; offsetMs: number; at: number }> = [];
  for (const row of rows) {
    const opened = new Date(row.opened_at).getTime();
    const end = row.closed_at ? new Date(row.closed_at).getTime() : now;
    const touch = Number(row.details?.firstTouchAt);
    const have = new Set(row.have ?? []);
    for (const p of trajectoryPoints(opened, Number.isFinite(touch) ? touch : null, end)) {
      const at = opened + p.offsetMs;
      if (at > now || have.has(p.label)) continue;
      due.push({ row, label: p.label, offsetMs: p.offsetMs, at });
    }
  }
  // Live points (due in the last 30 min) first, newest first; then history
  // signal by signal from the oldest, so whole trajectories complete for analysis.
  const live = (d: (typeof due)[number]) => now - d.at < 30 * 60_000;
  due.sort((a, b) => (Number(live(b)) - Number(live(a))) ||
    (live(a) ? b.at - a.at : a.row.id - b.row.id || a.at - b.at));
  // With ~100 open trades the live points alone could fill every pass and
  // starve history (2026-10-26: signals after #4 got nothing). At most half
  // of a pass goes to live points; the rest always advances history.
  const liveDue = due.filter(live);
  const history = due.filter((d) => !live(d));
  const half = Math.ceil(limit / 2);
  const picked = [...liveDue.slice(0, Math.max(half, limit - history.length)), ...history];
  due.length = 0;
  due.push(...picked);
  let done = 0;
  for (const d of due) {
    if (done >= limit) break;
    const { row, at } = d;
    const coin = book(row.symbol);
    if (!coversAsOf(coin, at)) continue; // candles not loaded yet / too old
    const price = priceAt(row.symbol, at);
    const dir = row.side === "long" ? 1 : -1;
    const btc = row.symbol === BTC ? null : book(BTC);
    const b = btc && coversAsOf(btc, at) ? marketMetrics(btc, at, "btc_") : null;
    const metrics = {
      ...marketMetrics(coin, at),
      ...(b ? { btc_chg1h: b.btc_chg1h, btc_chg24h: b.btc_chg24h } : {}),
      ...(await derivativeMetrics(row.symbol, at)),
    };
    await pool.query(
      `INSERT INTO nh_signal_trajectory (signal_id, label, at, elapsed_ms, price, pct_from_entry, metrics, reconstructed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (signal_id, label) DO NOTHING`,
      [row.id, d.label, new Date(at), d.offsetMs, price,
        price === null ? null : Math.round(((price - row.entry) / row.entry) * 100 * dir * 100) / 100,
        JSON.stringify(metrics), now - at > 15 * 60_000],
    );
    done += 1;
  }
  return done;
}

let backfillRunning = false;
export function startSnapshotBackfill(): void {
  const run = () => {
    if (backfillRunning) return;
    backfillRunning = true;
    void backfillSnapshots().then((r) => {
    if (r.entries || r.closes || r.unavailable || r.derivs || r.trajectory) logger.info(r, "nihilist: snapshot backfill");
    }).catch((err) => logger.warn({ err }, "nihilist: snapshot backfill failed"))
      .finally(() => { backfillRunning = false; });
  };
  setTimeout(run, 30_000).unref?.();
  // Every 2 minutes: trajectory points are due 15 minutes after entry.
  setInterval(run, 2 * 60_000).unref?.();
}
