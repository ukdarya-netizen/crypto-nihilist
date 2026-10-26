/**
 * Crypto Nihilist engine.
 *
 * Every 30 minutes, ~20 s after the 30m bar closes:
 *   1. refresh candles of every BingX perpetual (CoinGlass, closed bars only);
 *   2. advance open virtual trades on the new 30m bars;
 *   3. evaluate the setups whose lower timeframe just closed a bar:
 *      {4h, 1d} order block × {30m, 1h} CHoCH × {long, short}.
 *      Only a signal on the bar that has just closed opens a trade; after a
 *      pause nothing is opened late.
 * Every evaluated CHoCH inside a higher-timeframe block is written to
 * `nh_decisions` (accepted or the rejection reason).
 * Signals go to the dashboard only (owner decision, Telegram later).
 */
import { pool } from "@workspace/db";
import { INTERVAL_MS, type Interval } from "./candles";
import { captureSnapshot, ensureSnapshotTable, startSnapshotBackfill } from "../stats/snapshots";
import { evaluateSetups, type HtfInterval, type SetupCandidate, type SetupSignal } from "./setups";
import { COMBOS, MAX_HOLD_MS } from "./config";
import { openTrade } from "./trade";
import { BREAKEVEN_AT_PCT, LIVE_SETUPS, OB_MIN_DISPLACEMENT_ATR } from "./config";
import { insertEvent, startTracker } from "./tracker";
import { startTelegram } from "../telegram/telegram";
import { backfill, book, loadFromDb, needsBackfill, pruneDb, refresh } from "../market/candleStore";
import { getUniverse, setScanBusy, type UniverseSymbol } from "../market/coinglass";
import { waitForEngineLease } from "../ops/lease";
import { logger } from "../lib/logger";

/** LTF bars walked per evaluation (enough for the LTF structure to settle). */
const LTF_WINDOW = 400;
/** Minimum history before a symbol is evaluated. */
const MIN_BARS: Record<Interval, number> = { "5m": 0, "30m": 200, "1h": 200, "4h": 60, "1d": 30 };
const CYCLE_DELAY_MS = 20_000;
const UNIVERSE_REFRESH_MS = 24 * 60 * 60_000;

export type EngineStatus = {
  startedAt: number;
  leaseAcquired: boolean;
  universe: number;
  ready: number;
  backfillPending: number;
  lastCycleAt: number | null;
  lastCycleBar: number | null;
  lastCycleMs: number | null;
  lastCycleRefreshFailed: number;
  lastCycleSignals: number;
  lastCycleDecisions: number;
  lastError: string | null;
  /** Where startup is: lease -> universe -> loading_db -> running. */
  phase: string;
  /** Symbols whose stored candles have been loaded from the DB. */
  loadedFromDb: number;
  /** The scan running now (null between scans). */
  cycle: { bar: number; startedAt: number; stage: "refresh" | "late_retry" | "evaluate"; done: number; total: number } | null;
};

export type CycleRecord = {
  bar: number; startedAt: number; finishedAt: number; ms: number; checked: number; refreshFailed: number;
  lateRetries: number; candidates: number; signals: number; decisions: number; error: string | null;
};
export type Candidate = SetupCandidate & { symbol: string; htf: string; ltf: string; updatedAt: number };

const CYCLE_LOG_SIZE = 96; // two days of 30-minute scans
let cycleLog: CycleRecord[] = [];
/** symbol:htf:ltf -> blocks price is reacting from, from the last evaluation. */
const candidateMap = new Map<string, Candidate[]>();
export const scannerView = () => ({
  cycles: [...cycleLog].reverse(),
  candidates: [...candidateMap.values()].flat().sort((a, b) => b.lastTouchAt - a.lastTouchAt),
});

const status: EngineStatus = {
  startedAt: Date.now(), leaseAcquired: false, universe: 0, ready: 0, backfillPending: 0,
  phase: "lease", loadedFromDb: 0, cycle: null,
  lastCycleAt: null, lastCycleBar: null, lastCycleMs: null, lastCycleRefreshFailed: 0,
  lastCycleSignals: 0, lastCycleDecisions: 0, lastError: null,
};
export const engineStatus = (): EngineStatus => ({ ...status });

let universe: UniverseSymbol[] = [];
let universeAt = 0;
const ready = new Set<string>();

async function saveState(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

async function loadState<T>(key: string): Promise<T | null> {
  const { rows } = await pool.query<{ value: T }>("SELECT value FROM nh_state WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

async function refreshUniverse(now: number): Promise<void> {
  if (universe.length && now - universeAt < UNIVERSE_REFRESH_MS) return;
  const fresh = await getUniverse();
  if (fresh) {
    universe = fresh;
    universeAt = now;
    await saveState("universe", fresh);
  } else if (!universe.length) {
    universe = (await loadState<UniverseSymbol[]>("universe")) ?? [];
    logger.warn({ cached: universe.length }, "nihilist: universe request failed — using the stored list");
  }
  status.universe = universe.length;
}

function hasHistory(symbol: string): boolean {
  const b = book(symbol);
  return (Object.keys(MIN_BARS) as Interval[]).every((i) => b[i].length >= MIN_BARS[i]);
}

/** Background deep backfill; never blocks a cycle. */
async function backfillLoop(): Promise<void> {
  for (;;) {
    const pending = universe.filter((s) => needsBackfill(s.instrumentId));
    status.backfillPending = pending.length;
    for (const s of pending) {
      try {
        await backfill(s.instrumentId);
      } catch (err) {
        logger.warn({ err, symbol: s.instrumentId }, "nihilist: backfill failed");
      }
      if (hasHistory(s.instrumentId)) ready.add(s.instrumentId);
      status.backfillPending = Math.max(0, status.backfillPending - 1);
    }
    status.ready = ready.size;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function recordDecision(
  symbol: string, setup: string, barTime: number, decision: "accepted" | "rejected" | "skipped",
  reason: string | null, blockId: string, details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO nh_decisions (symbol, setup, bar_time, decision, reason, block_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [symbol, setup, barTime, decision, reason, blockId, JSON.stringify(details)],
  );
}

/**
 * One trade per coin and direction. Several setups often fire on the same
 * move (OB 4h and 1D, break 30m and 1h at the hour): that used to open the
 * same trade two or three times (duplicates in Telegram and in the stats).
 * When they fire together the highest-priority setup opens and records the
 * others as its confluence; while a trade is open, the coin is busy.
 */
export const SETUP_PRIORITY = ["1d_1h", "1d_30m", "4h_1h", "4h_30m"];
const priorityOf = (setup: string) => SETUP_PRIORITY.indexOf(setup.replace(/_(long|short)$/, ""));

async function openSignal(symbol: string, s: SetupSignal, confluence: string[] = [s.setup]): Promise<boolean> {
  const busy = await pool.query<{ id: number; setup: string }>(
    "SELECT id, setup FROM nh_signals WHERE status = 'open' AND symbol = $1 AND side = $2 LIMIT 1", [symbol, s.side],
  );
  if (busy.rowCount) {
    await recordDecision(symbol, s.setup, s.barTime, "skipped", "open_signal_same_symbol", s.block.id,
      { ...signalDetails(s), openSignalId: busy.rows[0].id, openSetup: busy.rows[0].setup });
    return false;
  }
  const trade = openTrade({
    side: s.side, entry: s.entry, stop: s.stop, tp1: s.tp1,
    openedAt: s.signalAt, maxHoldMs: MAX_HOLD_MS[s.htf], breakevenAtPct: BREAKEVEN_AT_PCT,
  });
  const live = LIVE_SETUPS.has(s.setup);
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO nh_signals (symbol, setup, htf, ltf, side, block_id, block_top, block_bottom, block_scope,
       bar_time, entry, stop, tp1, tp2, risk_pct, rr1, targets_source, opened_at, expires_at, details,
       live, current_stop)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      symbol, s.setup, s.htf, s.ltf, s.side, s.block.id, s.block.top, s.block.bottom, s.block.scope,
      s.barTime, s.entry, s.stop, s.tp1, s.tp2, s.riskPct, s.rr1, s.targetsSource,
      new Date(trade.openedAt), new Date(trade.expiresAt), JSON.stringify({ ...signalDetails(s), confluenceSetups: confluence }),
      live, s.stop,
    ],
  );
  await recordDecision(symbol, s.setup, s.barTime, "accepted", null, s.block.id, signalDetails(s));
  const id = inserted.rows[0]?.id;
  if (id === undefined) return false;
  await captureSnapshot(id, {
    symbol, side: s.side, htf: s.htf, ltf: s.ltf, entry: s.entry, stop: s.stop, tp1: s.tp1,
    riskPct: s.riskPct, rr1: s.rr1, blockTop: s.block.top, blockBottom: s.block.bottom, blockScope: s.block.scope,
    blockTime: s.block.time, blockCreatedAt: s.block.createdAt, firstTouchAt: s.firstTouchAt, lastTouchAt: s.lastTouchAt,
    htfSwingTrend: s.htfSwingTrend, htfInternalTrend: s.htfInternalTrend, ltfAtr: s.ltfAtr,
    ob: s.ob, confluenceSetups: confluence, targetsSource: s.targetsSource, signalAt: s.signalAt,
  });
  await insertEvent(id, `${id}:opened`, "opened", s.entry, signalDetails(s), s.signalAt);
  return true;
}

function signalDetails(s: SetupSignal): Record<string, unknown> {
  return {
    entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2, riskPct: s.riskPct, rr1: s.rr1, rr2: s.rr2,
    targetsSource: s.targetsSource, blockScope: s.block.scope, blockTop: s.block.top, blockBottom: s.block.bottom,
    blockTime: s.block.time, blockCreatedAt: s.block.createdAt, firstTouchAt: s.firstTouchAt,
    lastTouchAt: s.lastTouchAt, extreme: s.extreme, chochLevel: s.chochLevel,
    htfSwingTrend: s.htfSwingTrend, htfInternalTrend: s.htfInternalTrend, ltfAtr: s.ltfAtr,
    ob: s.ob,
  };
}

/** symbol:ltf -> close time of the last LTF bar already evaluated. */
const evaluatedUpTo = new Map<string, number>();

/**
 * Evaluates the LTF bars of one symbol that closed since the last
 * evaluation. A bar is used only while it is the latest closed bar of its
 * timeframe (a signal is never opened one bar late); the first evaluation
 * after a start only marks the current bar.
 */
export async function evaluateSymbol(symbol: string, now = Date.now()): Promise<{ signals: number; decisions: number }> {
  const b = book(symbol);
  let signals = 0;
  let decisions = 0;
  const fresh: SetupSignal[] = [];
  for (const combo of COMBOS) {
    const ltfSeries = b[combo.ltf];
    const last = ltfSeries[ltfSeries.length - 1];
    if (!last) continue;
    const span = INTERVAL_MS[combo.ltf];
    const closeAt = last.t + span;
    const key = `${symbol}:${combo.htf}:${combo.ltf}`;
    const done = evaluatedUpTo.get(key);
    evaluatedUpTo.set(key, closeAt);
    if (done === undefined || closeAt <= done) continue;
    if (now - closeAt > span) continue; // too late: the next bar has already closed
    const { signals: found, rejections, candidates } = evaluateSetups({
      htf: combo.htf, ltf: combo.ltf,
      htfCandles: b[combo.htf], ltfCandles: ltfSeries.slice(-LTF_WINDOW),
      options: { minObDisplacementAtr: OB_MIN_DISPLACEMENT_ATR },
    });
    candidateMap.set(key, candidates.map((c) => ({ ...c, symbol, htf: combo.htf, ltf: combo.ltf, updatedAt: now })));
    for (const r of rejections) {
      if (r.signalAt !== closeAt) continue;
      decisions += 1;
      await recordDecision(symbol, r.setup, r.barTime, "rejected", r.reason, r.blockId, r.details);
    }
    for (const s of found) if (s.signalAt === closeAt) fresh.push(s);
  }
  // Same move, several setups: open one per direction, the rest is confluence.
  for (const side of ["long", "short"] as const) {
    const group = fresh.filter((x) => x.side === side).sort((a, b) => priorityOf(a.setup) - priorityOf(b.setup));
    if (!group.length) continue;
    const [main, ...rest] = group;
    const confluence = group.map((x) => x.setup);
    decisions += group.length;
    if (await openSignal(symbol, main, confluence)) signals += 1;
    for (const dup of rest) {
      await recordDecision(symbol, dup.setup, dup.barTime, "skipped", "duplicate_same_move", dup.block.id,
        { ...signalDetails(dup), mainSetup: main.setup });
    }
  }
  return { signals, decisions };
}

async function runCycle(bar: number): Promise<void> {
  const started = Date.now();
  await refreshUniverse(started);
  let failed = 0;
  let signals = 0;
  let decisions = 0;
  let lateRetries = 0;
  let error: string | null = null;
  const symbols = universe.map((s) => s.instrumentId).filter((s) => ready.has(s));
  const cycle = { bar, startedAt: started, stage: "refresh" as "refresh" | "late_retry" | "evaluate", done: 0, total: symbols.length };
  status.cycle = cycle;
  setScanBusy(true);
  try {
    // Requests run in parallel up to the CoinGlass governor's limits.
    const refreshed = await Promise.all(symbols.map(async (symbol) => {
      try {
        return { symbol, ok: (await refresh(symbol)) !== null };
      } catch (err) {
        logger.warn({ err, symbol }, "nihilist: refresh failed");
        return { symbol, ok: false };
      } finally {
        cycle.done += 1;
      }
    }));
    // CoinGlass can publish the just-closed bar a little late: retry those symbols.
    for (let attempt = 0; attempt < 3; attempt++) {
      const late = refreshed.filter(({ symbol, ok }) => {
        const s = book(symbol)["30m"];
        return ok && (!s.length || s[s.length - 1].t + INTERVAL_MS["30m"] < bar);
      });
      if (!late.length) break;
      lateRetries += late.length;
      cycle.stage = "late_retry";
      await new Promise((r) => setTimeout(r, 45_000));
      await Promise.all(late.map(async (item) => {
        try { item.ok = (await refresh(item.symbol)) !== null; } catch { item.ok = false; }
      }));
    }
    setScanBusy(false);
    cycle.stage = "evaluate";
    cycle.done = 0;
    for (const { symbol, ok } of refreshed) {
      cycle.done += 1;
      if (!ok) { failed += 1; candidateMap.forEach((_, k) => { if (k.startsWith(`${symbol}:`)) candidateMap.delete(k); }); continue; } // no data — no signal
      try {
        const result = await evaluateSymbol(symbol);
        signals += result.signals;
        decisions += result.decisions;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        status.lastError = error;
        logger.error({ err, symbol }, "nihilist: evaluation failed");
      }
    }
  } finally {
    setScanBusy(false);
    status.cycle = null;
    const finishedAt = Date.now();
    cycleLog.push({
      bar, startedAt: started, finishedAt, ms: finishedAt - started, checked: symbols.length, refreshFailed: failed,
      lateRetries, candidates: [...candidateMap.values()].reduce((a, c) => a + c.length, 0), signals, decisions, error,
    });
    if (cycleLog.length > CYCLE_LOG_SIZE) cycleLog = cycleLog.slice(-CYCLE_LOG_SIZE);
    await saveState("cycles", cycleLog).catch(() => undefined);
  }
  status.lastCycleAt = Date.now();
  status.lastCycleBar = bar;
  status.lastCycleMs = Date.now() - started;
  status.lastCycleRefreshFailed = failed;
  status.lastCycleSignals = signals;
  status.lastCycleDecisions = decisions;
  status.ready = ready.size;
  await saveState("engine", status);
  logger.info({ ...status }, "nihilist: cycle done");
}

export async function startEngine(): Promise<void> {
  await waitForEngineLease();
  status.leaseAcquired = true;
  cycleLog = (await loadState<CycleRecord[]>("cycles").catch(() => null)) ?? [];
  status.phase = "universe";
  await refreshUniverse(Date.now());
  // Stored candles load in parallel batches; each symbol becomes ready as
  // soon as its own history is in memory. The backfill waits for this load
  // (it must see what is stored), the cycle only uses ready symbols.
  status.phase = "loading_db";
  const ids = universe.map((s) => s.instrumentId);
  const BATCH = 16;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      await loadFromDb(batch);
    } catch (err) {
      status.lastError = `load_from_db: ${err instanceof Error ? err.message : String(err)}`;
      logger.error({ err }, "nihilist: loading stored candles failed");
    }
    for (const symbol of batch) {
      if (!hasHistory(symbol)) continue;
      ready.add(symbol);
      await evaluateSymbol(symbol); // marks the current bars: nothing is opened late after a restart
    }
    status.loadedFromDb = Math.min(ids.length, i + BATCH);
    status.ready = ready.size;
    if (i % (BATCH * 16) === 0) logger.info({ loaded: status.loadedFromDb, ready: ready.size }, "nihilist: loading stored candles");
  }
  status.phase = "running";
  status.ready = ready.size;
  await ensureSnapshotTable().catch((err) => logger.error({ err }, "nihilist: snapshot table unavailable"));
  startSnapshotBackfill();
  void backfillLoop();
  startTracker();
  startTelegram();
  let lastBar = Math.floor(Date.now() / INTERVAL_MS["30m"]) * INTERVAL_MS["30m"];
  let lastPrune = 0;
  const tick = async () => {
    const now = Date.now();
    const bar = Math.floor((now - CYCLE_DELAY_MS) / INTERVAL_MS["30m"]) * INTERVAL_MS["30m"];
    if (bar > lastBar) {
      lastBar = bar;
      try {
        await runCycle(bar);
      } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "nihilist: cycle failed");
      }
    }
    if (now - lastPrune > 24 * 60 * 60_000) {
      lastPrune = now;
      await pruneDb().catch((err) => logger.warn({ err }, "nihilist: prune failed"));
    }
    setTimeout(() => void tick(), 15_000);
  };
  void tick();
}
