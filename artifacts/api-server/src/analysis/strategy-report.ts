/**
 * Strategy report for the trading bot (owner 2026-11-03): every management
 * variant of strategy-sim.ts on
 *   1. live — every published Nihilist signal (stored 30m candles);
 *   2. history — the same setups over the last 60 days on every BingX pair
 *      (CoinGlass, at low priority: waits for the scan, so signals are never
 *      delayed), one open trade per coin and side, as the trading bot.
 * Longs are reported twice — those that pass today's entry filter (what is
 * traded now) and all — and shorts apart. Started by the owner from the
 * dashboard; progress and result live in nh_state "strategy_report".
 */
import { pool } from "@workspace/db";
import { INTERVAL_MS, type Candle, type Interval } from "../engine/candles";
import { COMBOS, MAX_HOLD_MS, candidateChecks, entryFilter, type CandidateChecks } from "../engine/config";
import { atr, closedAsOf } from "../engine/metrics";
import { evaluateSetups, type SetupSignal } from "../engine/setups";
import { SETUP_PRIORITY } from "../engine/runtime";
import { getCandleHistory, getUniverse, waitForScanIdle } from "../market/coinglass";
import { logger } from "../lib/logger";
import { simulate, stats, variants, type Mgmt, type Row, type SimTrade, type Stats } from "./strategy-sim";

const KEY = "strategy_report";
const SPAN = INTERVAL_MS["30m"];
export const HISTORY_DAYS = 60;
const WARMUP = 400;

export type Group = "long_filtered" | "long_all" | "short";
export type DatasetReport = {
  name: "live" | "history";
  from: string | null; to: string | null; trades: number; symbols: number; skippedSymbols: number;
  groups: Record<Group, Array<{ id: string; label: string; stats: Stats }>>;
  /** Candidate entry filters (owner 2026-11-03): each set followed as its own stream of trades. */
  filters?: Array<{ id: string; side: "long" | "short"; label: string; stats: Record<string, Stats> }>;
};

/**
 * Filter sets checked (owner 2026-11-03). Longs on top of today's filter (each new filter
 * alone and all three), plus all longs and the three new filters without today's one;
 * shorts (not filtered today) — ATR, strength, both. Each set is a separate stream with
 * one open trade per coin and side, as the trading bot.
 */
export const FILTER_SETS: Array<{ id: string; side: "long" | "short"; label: string; test: (today: boolean, c: CandidateChecks) => boolean }> = [
  { id: "long_any", side: "long", label: "Лонги: все, без фильтра", test: () => true },
  { id: "long_today", side: "long", label: "Лонги: фильтр сейчас (стоп ≥7%, блок ≤300ч, ≥4%)", test: (t) => t },
  { id: "long_atr", side: "long", label: "сейчас + ATR 30m ≥ 1.3%", test: (t, c) => t && c.atr },
  { id: "long_disp", side: "long", label: "сейчас + слом за блоком ≥ 0.9 ATR", test: (t, c) => t && c.disp },
  { id: "long_pen", side: "long", label: "сейчас + заход в блок ≥ 23%", test: (t, c) => t && c.pen },
  { id: "long_all3", side: "long", label: "сейчас + все три новых", test: (t, c) => t && c.atr && c.disp && c.pen },
  { id: "long_new3", side: "long", label: "только три новых (без фильтра сейчас)", test: (_t, c) => c.atr && c.disp && c.pen },
  { id: "short_any", side: "short", label: "Шорты: все (фильтра сейчас нет)", test: () => true },
  { id: "short_atr", side: "short", label: "ATR 30m ≥ 1.0%", test: (_t, c) => c.atr },
  { id: "short_disp", side: "short", label: "слом за блоком ≥ 0.9 ATR", test: (_t, c) => c.disp },
  { id: "short_both", side: "short", label: "ATR + слом", test: (_t, c) => c.atr && c.disp },
];
/** The ways the trading bot can lead a Nihilist trade. */
export const TRADED = ["source", "take5", "take10", "take15"] as const;
const setsOf = (side: "long" | "short", today: boolean, c: CandidateChecks) =>
  FILTER_SETS.filter((f) => f.side === side && f.test(today, c)).map((f) => f.id);

/** ATR(14) of closed 30m bars at the moment, % of the last close — as «ATR 30m» on the metrics page. */
export function atr30PctAt(candles30m: Candle[], at: number): number | null {
  const closed = closedAsOf(candles30m, "30m", at).slice(-200);
  const a = atr(closed);
  const last = closed[closed.length - 1]?.c;
  return a !== null && last ? (a / last) * 100 : null;
}
export type Report = {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null; finishedAt: string | null; error: string | null;
  progress: { stage: string; done: number; total: number };
  datasets: DatasetReport[];
  variants: Array<Pick<Mgmt, "id" | "label">>;
  parity: { checked: number; mismatched: number } | null;
};

type Item = { trade: SimTrade; group: Group[]; sets: string[]; candles: Candle[] };

async function save(r: Report): Promise<void> {
  await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(r)],
  );
}
export async function loadReport(): Promise<Report | null> {
  const { rows } = await pool.query<{ value: Report }>("SELECT value FROM nh_state WHERE key = $1", [KEY]);
  const r = rows[0]?.value ?? null;
  // A run lives in this process only: after a restart (publish) it is gone, not "still running".
  if (r && r.status === "running" && !running) {
    return { ...r, status: "failed", error: "расчёт прерван перезапуском сервера (публикация) — запустите заново" };
  }
  return r;
}

const groupsOf = (side: "long" | "short", passes: boolean): Group[] =>
  side === "short" ? ["short"] : passes ? ["long_filtered", "long_all"] : ["long_all"];

/** Results of every variant, filled trade by trade (candles are not kept). */
class Acc {
  private rows = new Map<string, Record<Group, Row[]>>();
  private open = new Map<string, Record<Group, number>>();
  private times: number[] = [];
  private fRows = new Map<string, Record<string, Row[]>>();
  private fOpen = new Map<string, Record<string, number>>();
  constructor(private readonly ms: Mgmt[] = variants()) {
    for (const m of ms) {
      this.rows.set(m.id, { long_filtered: [], long_all: [], short: [] });
      this.open.set(m.id, { long_filtered: 0, long_all: 0, short: 0 });
    }
    for (const f of FILTER_SETS) {
      this.fRows.set(f.id, Object.fromEntries(TRADED.map((id) => [id, []])));
      this.fOpen.set(f.id, Object.fromEntries(TRADED.map((id) => [id, 0])));
    }
  }
  add(it: Item): void {
    if (!it.group.length && !it.sets.length) return;
    if (it.group.length) this.times.push(it.trade.openedAt);
    for (const m of this.ms) {
      const inSets = (TRADED as readonly string[]).includes(m.id) ? it.sets : [];
      if (!it.group.length && !inSets.length) continue;
      const r = simulate(it.trade, it.candles, SPAN, m);
      const row = r.closed ? { tradeId: it.trade.id, openedAt: it.trade.openedAt, closedAt: r.closedAt!, pnlPct: r.pnlPct, reason: r.reason!, holdH: r.holdH, peakPct: r.peakPct } : null;
      for (const g of it.group) {
        if (!row) { this.open.get(m.id)![g] += 1; continue; }
        this.rows.get(m.id)![g].push(row);
      }
      for (const f of inSets) {
        if (!row) { this.fOpen.get(f)![m.id] += 1; continue; }
        this.fRows.get(f)![m.id].push(row);
      }
    }
  }
  report(name: DatasetReport["name"], symbols: number, skipped: number): DatasetReport {
    const groups = { long_filtered: [], long_all: [], short: [] } as DatasetReport["groups"];
    for (const m of this.ms) for (const g of Object.keys(groups) as Group[]) {
      groups[g].push({ id: m.id, label: m.label, stats: stats(this.rows.get(m.id)![g], this.open.get(m.id)![g]) });
    }
    const filters = FILTER_SETS.map((f) => ({
      id: f.id, side: f.side, label: f.label,
      stats: Object.fromEntries(TRADED.map((id) => [id, stats(this.fRows.get(f.id)![id], this.fOpen.get(f.id)![id])])),
    }));
    return {
      name, trades: this.times.length, symbols, skippedSymbols: skipped, groups, filters,
      from: this.times.length ? new Date(Math.min(...this.times)).toISOString() : null,
      to: this.times.length ? new Date(Math.max(...this.times)).toISOString() : null,
    };
  }
}

// ---------- live ----------
type LiveRow = {
  id: number; symbol: string; side: "long" | "short"; htf: "4h" | "1d"; entry: number; stop: number; risk_pct: number;
  opened_at: Date; block_top: number; block_bottom: number; details: any; metrics: Record<string, unknown> | null;
};
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function liveItems(): Promise<{ items: Item[]; symbols: number; skipped: number }> {
  const { rows } = await pool.query<LiveRow>(
    `SELECT s.id, s.symbol, s.side, s.htf, s.entry, s.stop, s.risk_pct, s.opened_at, s.block_top, s.block_bottom, s.details,
       (SELECT n.metrics FROM nh_signal_snapshots n WHERE n.signal_id = s.id ORDER BY n.version DESC LIMIT 1) AS metrics
     FROM nh_signals s WHERE s.live ORDER BY s.opened_at`,
  );
  const bySymbol = new Map<string, LiveRow[]>();
  for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  const items: Item[] = [];
  let skipped = 0;
  for (const [symbol, list] of bySymbol) {
    const from = Math.min(...list.map((r) => r.opened_at.getTime())) - SPAN;
    const { rows: cs } = await pool.query<{ t: string; o: number; h: number; l: number; c: number }>(
      "SELECT t, o, h, l, c FROM nh_candles WHERE symbol = $1 AND interval = '30m' AND t >= $2 ORDER BY t", [symbol, from],
    );
    const candles = cs.map((c) => ({ t: Number(c.t), o: c.o, h: c.h, l: c.l, c: c.c }));
    for (const r of list) {
      const openedAt = r.opened_at.getTime();
      // A trade whose first candle after the entry is not stored (older than the 15 days kept) is left out.
      if (!candles.some((c) => c.t + SPAN > openedAt && c.t <= openedAt + SPAN)) { skipped += 1; continue; }
      const d = r.details ?? {};
      const passes = d.entryFilter?.pass ?? entryFilter({
        side: r.side, riskPct: r.risk_pct, entry: r.entry, blockTop: r.block_top, blockBottom: r.block_bottom,
        signalAt: openedAt, blockCreatedAt: d.blockCreatedAt ?? null, blockTime: d.blockTime ?? null,
      }).pass;
      // Candidate filters on live signals: the values recorded at the signal (metrics snapshot, else signal details).
      const m = r.metrics ?? {};
      const checks = candidateChecks({
        side: r.side, atr30Pct: numOrNull(m.atrpct_30m),
        displacementAtr: numOrNull(m.ob_displacement_atr) ?? numOrNull(d.ob?.displacementAtr),
        penetrationPct: numOrNull(m.ob_penetration_pct) ?? numOrNull(d.ob?.penetrationPct),
      });
      items.push({
        trade: { id: `nh-${r.id}`, side: r.side, entry: r.entry, stop: r.stop, openedAt, maxHoldMs: MAX_HOLD_MS[r.htf] },
        group: groupsOf(r.side, passes), sets: setsOf(r.side, passes, checks), candles,
      });
    }
  }
  return { items, symbols: bySymbol.size, skipped };
}

// ---------- history ----------
type Data = Record<Exclude<Interval, "5m">, Candle[]>;

async function history(symbol: string): Promise<Data | null> {
  const want: Record<Exclude<Interval, "5m">, number> = {
    "30m": HISTORY_DAYS * 48 + WARMUP, "1h": HISTORY_DAYS * 24 + WARMUP, "4h": 700, "1d": 500,
  };
  const out = {} as Data;
  for (const interval of Object.keys(want) as Array<keyof Data>) {
    await waitForScanIdle(); // the live scan always goes first
    const candles = await getCandleHistory(symbol, interval, want[interval]);
    if (!candles || candles.length < 50) return null;
    out[interval] = candles.filter((c) => c.t + INTERVAL_MS[interval] <= Date.now());
  }
  return out;
}

const SOURCE = variants()[0]!;
const prio = (s: SetupSignal) => SETUP_PRIORITY.indexOf(`${s.htf}_${s.ltf}`);

/** Signals of one coin as live: one open trade per side (by Nihilist's own management), best setup first. */
export function historySignals(symbol: string, data: Data, now = Date.now()): Item[] {
  const from = now - HISTORY_DAYS * 86_400_000;
  const all: SetupSignal[] = [];
  for (const combo of COMBOS) {
    const { signals } = evaluateSetups({ htf: combo.htf, ltf: combo.ltf, htfCandles: data[combo.htf], ltfCandles: data[combo.ltf] });
    all.push(...signals.filter((s) => s.signalAt >= from));
  }
  all.sort((a, b) => a.signalAt - b.signalAt || prio(a) - prio(b));
  // One open trade per coin and side. Longs are followed twice: every long ("long_all") and only the
  // longs that pass today's filter ("long_filtered") — a failed long never blocks a filtered one.
  // Each candidate filter set is its own stream too.
  const busy: Record<string, number> = { long_all: 0, long_filtered: 0, short: 0 };
  for (const f of FILTER_SETS) busy[`f:${f.id}`] = 0;
  const items: Item[] = [];
  for (const s of all) {
    const passes = s.side === "short" || entryFilter({
      side: s.side, riskPct: s.riskPct, entry: s.entry, blockTop: s.block.top, blockBottom: s.block.bottom,
      signalAt: s.signalAt, blockCreatedAt: s.block.createdAt ?? null, blockTime: s.block.time ?? null,
    }).pass;
    const group = groupsOf(s.side, passes).filter((g) => s.signalAt >= busy[g]!);
    const checks = candidateChecks({
      side: s.side, atr30Pct: atr30PctAt(data["30m"], s.signalAt), displacementAtr: s.ob.displacementAtr, penetrationPct: s.ob.penetrationPct,
    });
    const sets = setsOf(s.side, passes, checks).filter((f) => s.signalAt >= busy[`f:${f}`]!);
    if (!group.length && !sets.length) continue;
    const trade: SimTrade = { id: `${symbol}:${s.setup}:${s.signalAt}`, side: s.side, entry: s.entry, stop: s.stop, openedAt: s.signalAt, maxHoldMs: MAX_HOLD_MS[s.htf] };
    const base = simulate(trade, data["30m"], SPAN, SOURCE);
    const until = base.closed ? base.closedAt! : Infinity;
    for (const g of group) busy[g] = until;
    for (const f of sets) busy[`f:${f}`] = until;
    const start = trade.openedAt - SPAN, end = trade.openedAt + trade.maxHoldMs + SPAN;
    items.push({ trade, group, sets, candles: data["30m"].filter((c) => c.t >= start && c.t <= end) });
  }
  return items;
}

let running = false;

export async function runStrategyReport(opts: { history?: boolean } = {}): Promise<void> {
  if (running) return;
  running = true;
  const report: Report = {
    status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null,
    progress: { stage: "live", done: 0, total: 1 }, datasets: [], variants: variants().map(({ id, label }) => ({ id, label })), parity: null,
  };
  try {
    await save(report);
    const live = await liveItems();
    const liveAcc = new Acc();
    for (const it of live.items) liveAcc.add(it);
    report.datasets.push(liveAcc.report("live", live.symbols, live.skipped));
    report.parity = await parityCheck(live.items);
    report.progress = { stage: "live", done: 1, total: 1 };
    await save(report);

    if (opts.history !== false) {
      const universe = await getUniverse();
      if (!universe) throw new Error("CoinGlass: список монет не получен");
      const acc = new Acc();
      let skipped = 0;
      report.progress = { stage: "history", done: 0, total: universe.length };
      for (const [i, u] of universe.entries()) {
        const data = await history(u.instrumentId).catch(() => null);
        if (!data) skipped += 1;
        else {
          for (const it of historySignals(u.instrumentId, data)) acc.add(it);
        }
        if ((i + 1) % 10 === 0 || i + 1 === universe.length) {
          report.progress = { stage: "history", done: i + 1, total: universe.length };
          await save(report);
        }
        await new Promise((r) => setImmediate(r));
      }
      report.datasets.push(acc.report("history", universe.length - skipped, skipped));
    }
    report.status = "done";
    report.finishedAt = new Date().toISOString();
    await save(report);
  } catch (err) {
    logger.warn({ err }, "nihilist: strategy report failed");
    report.status = "failed";
    report.error = err instanceof Error ? err.message : String(err);
    report.finishedAt = new Date().toISOString();
    await save(report).catch(() => undefined);
  } finally {
    running = false;
  }
}
export const strategyReportRunning = () => running;

/**
 * The "source" variant must reproduce Nihilist's own closed live trades
 * opened after take profits were removed (same management): count of trades
 * whose close reason differs. Different candles (live 5m vs 30m here) make a
 * few differences normal; many would mean the simulation is wrong.
 */
async function parityCheck(items: Item[]): Promise<{ checked: number; mismatched: number }> {
  const { rows } = await pool.query<{ id: number; close_reason: string }>(
    `SELECT id, close_reason FROM nh_signals WHERE live AND status = 'closed' AND targets_source = 'trailing_only' AND close_reason IS NOT NULL`,
  );
  const real = new Map(rows.map((r) => [`nh-${r.id}`, r.close_reason]));
  let checked = 0, mismatched = 0;
  for (const it of items) {
    const want = real.get(it.trade.id);
    if (!want) continue;
    const r = simulate(it.trade, it.candles, SPAN, SOURCE);
    if (!r.closed) continue;
    checked += 1;
    if (r.reason !== want) mismatched += 1;
  }
  return { checked, mismatched };
}
