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
import { COMBOS, MAX_HOLD_MS, entryFilter } from "../engine/config";
import { evaluateSetups, type SetupSignal, type SmcChecks } from "../engine/setups";
import { SETUP_PRIORITY } from "../engine/runtime";
import { getCandleHistory, getUniverse, waitForScanIdle } from "../market/coinglass";
import { logger } from "../lib/logger";
import { simulate, stats, variants, type Mgmt, type Row, type SimTrade, type Stats } from "./strategy-sim";

const KEY = "strategy_report";
const SPAN = INTERVAL_MS["30m"];
export const HISTORY_DAYS = 60;
const WARMUP = 400;

export type Group = "long_filtered" | "long_all" | "short" | "short_risk_hi" | "short_risk_lo";
/**
 * Owner 2026-11-10: shorts are also reported apart by the stop distance — in the final study (315 shorts
 * 26.10–09.11) shorts with risk ≥ 9.5% did better with an earlier take (+5/+6%) and the rest with +8%; at 10x
 * such a stop is also beyond the liquidation price. Each group is its own stream (one trade per coin).
 */
export const SHORT_RISK_SPLIT_PCT = 9.5;
export const GROUPS: Group[] = ["long_filtered", "long_all", "short", "short_risk_hi", "short_risk_lo"];
const emptyGroups = <T,>(v: () => T) => Object.fromEntries(GROUPS.map((g) => [g, v()])) as Record<Group, T>;
export type DatasetReport = {
  name: "live" | "history";
  from: string | null; to: string | null; trades: number; symbols: number; skippedSymbols: number;
  groups: Record<Group, Array<{ id: string; label: string; stats: Stats }>>;
  /** SMC rules (owner 2026-11-04): each set followed as its own stream of trades. */
  filters?: Array<{ id: string; side: "long" | "short"; label: string; stats: Record<string, Stats> }>;
  /** Live signals whose SMC conditions could not be measured (not stored and not reproduced on the history). */
  smcUnknown?: number;
  /** Live only (owner 2026-11-04): every trade with its result and which rules it passes. */
  tradeList?: LiveTradeRow[];
};

export type LiveTradeRow = {
  symbol: string; side: "long" | "short"; setup: string; openedAt: string;
  /** Result, % of the entry net of fees (open: at the last close), and how it closed (null = open). */
  source: { pnlPct: number; reason: string | null }; take5: { pnlPct: number; reason: string | null };
  /** Today's long filter (shorts: null — not filtered). */
  today: boolean | null;
  smc: SmcChecks | null;
};

/**
 * Classic SMC rules the setup does not require (owner 2026-11-04), checked one by one and all
 * together: longs on top of all longs and on top of today's filter, shorts on top of all shorts.
 * An unknown value fails its rule. Each set is a separate stream with one open trade per coin
 * and side, as the trading bot.
 */
type Rule = { id: keyof SmcChecks | "all"; label: (side: "long" | "short") => string };
const RULES: Rule[] = [
  { id: "trendSwing", label: () => "тренд старшего ТФ (swing) по ходу" },
  { id: "trendInternal", label: () => "тренд старшего ТФ (internal) по ходу" },
  { id: "discount", label: (s) => (s === "long" ? "вход в дисконте (нижняя половина диапазона)" : "вход в премиуме (верхняя половина диапазона)") },
  { id: "sweep", label: () => "снятие ликвидности перед сломом" },
  { id: "fvg", label: () => "имбаланс (FVG) у блока" },
  { id: "fresh", label: () => "блок нетронутый (первое касание)" },
  { id: "all", label: () => "все SMC: swing-тренд, зона, ликвидность, FVG, нетронутый" },
];
const ALL_SMC: Array<keyof SmcChecks> = ["trendSwing", "discount", "sweep", "fvg", "fresh"];
const passRule = (id: Rule["id"], c: SmcChecks | null) =>
  c !== null && (id === "all" ? ALL_SMC.every((k) => c[k] === true) : c[id] === true);

export const FILTER_SETS: Array<{ id: string; side: "long" | "short"; label: string; test: (today: boolean, c: SmcChecks | null) => boolean }> = [
  { id: "long_any", side: "long", label: "Лонги: все", test: () => true },
  ...RULES.map((r) => ({ id: `long_any_${r.id}`, side: "long" as const, label: `все + ${r.label("long")}`, test: (_t: boolean, c: SmcChecks | null) => passRule(r.id, c) })),
  { id: "long_today", side: "long", label: "Лонги: фильтр сейчас (стоп ≥7%, блок ≤300ч, ≥4%)", test: (t) => t },
  ...RULES.map((r) => ({ id: `long_today_${r.id}`, side: "long" as const, label: `сейчас + ${r.label("long")}`, test: (t: boolean, c: SmcChecks | null) => t && passRule(r.id, c) })),
  { id: "short_any", side: "short", label: "Шорты: все", test: () => true },
  ...RULES.map((r) => ({ id: `short_any_${r.id}`, side: "short" as const, label: `все + ${r.label("short")}`, test: (_t: boolean, c: SmcChecks | null) => passRule(r.id, c) })),
];
/** The ways the trading bot can lead a Nihilist trade. */
export const TRADED = ["source", "take5", "take10", "take15"] as const;
const setsOf = (side: "long" | "short", today: boolean, c: SmcChecks | null) =>
  FILTER_SETS.filter((f) => f.side === side && f.test(today, c)).map((f) => f.id);

export type Report = {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null; finishedAt: string | null; error: string | null;
  progress: { stage: string; done: number; total: number };
  datasets: DatasetReport[];
  variants: Array<Pick<Mgmt, "id" | "label">>;
  parity: { checked: number; mismatched: number } | null;
};

type Item = { trade: SimTrade; group: Group[]; sets: string[]; candles: Candle[]; row?: Omit<LiveTradeRow, "source" | "take5"> };

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

const groupsOf = (side: "long" | "short", passes: boolean, riskPct: number): Group[] =>
  side === "short" ? ["short", riskPct >= SHORT_RISK_SPLIT_PCT ? "short_risk_hi" : "short_risk_lo"]
    : passes ? ["long_filtered", "long_all"] : ["long_all"];

/** Results of every variant, filled trade by trade (candles are not kept). */
class Acc {
  private rows = new Map<string, Record<Group, Row[]>>();
  private open = new Map<string, Record<Group, number>>();
  private times: number[] = [];
  private fRows = new Map<string, Record<string, Row[]>>();
  private fOpen = new Map<string, Record<string, number>>();
  constructor(private readonly ms: Mgmt[] = variants()) {
    for (const m of ms) {
      this.rows.set(m.id, emptyGroups<Row[]>(() => []));
      this.open.set(m.id, emptyGroups(() => 0));
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
  report(name: DatasetReport["name"], symbols: number, skipped: number, smcUnknown?: number): DatasetReport {
    const groups = emptyGroups(() => []) as DatasetReport["groups"];
    for (const m of this.ms) for (const g of Object.keys(groups) as Group[]) {
      groups[g].push({ id: m.id, label: m.label, stats: stats(this.rows.get(m.id)![g], this.open.get(m.id)![g]) });
    }
    const filters = FILTER_SETS.map((f) => ({
      id: f.id, side: f.side, label: f.label,
      stats: Object.fromEntries(TRADED.map((id) => [id, stats(this.fRows.get(f.id)![id], this.fOpen.get(f.id)![id])])),
    }));
    return {
      name, trades: this.times.length, symbols, skippedSymbols: skipped, groups, filters, ...(smcUnknown !== undefined ? { smcUnknown } : {}),
      from: this.times.length ? new Date(Math.min(...this.times)).toISOString() : null,
      to: this.times.length ? new Date(Math.max(...this.times)).toISOString() : null,
    };
  }
}

// ---------- live ----------
type LiveRow = {
  id: number; symbol: string; setup: string; side: "long" | "short"; htf: "4h" | "1d"; entry: number; stop: number; risk_pct: number;
  bar_time: string; opened_at: Date; block_top: number; block_bottom: number; details: any;
};
const smcKey = (symbol: string, setup: string, barTime: number) => `${symbol}|${setup}|${barTime}`;

async function liveRows(): Promise<LiveRow[]> {
  const { rows } = await pool.query<LiveRow>(
    `SELECT id, symbol, setup, side, htf, entry, stop, risk_pct, bar_time, opened_at, block_top, block_bottom, details
     FROM nh_signals WHERE live ORDER BY opened_at`,
  );
  return rows;
}

/**
 * Live signals as trades. SMC conditions: those stored with the signal (from 2026-11-04), else the
 * same signal reproduced on the 60-day history (same setup and bar); else unknown (counted).
 */
async function liveItems(rows: LiveRow[], smc: Map<string, SmcChecks>): Promise<{ items: Item[]; symbols: number; skipped: number; smcUnknown: number }> {
  const bySymbol = new Map<string, LiveRow[]>();
  for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
  const items: Item[] = [];
  let skipped = 0, smcUnknown = 0;
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
      const checks: SmcChecks | null = d.smc ?? smc.get(smcKey(symbol, r.setup, Number(r.bar_time))) ?? null;
      if (!checks) smcUnknown += 1;
      items.push({
        trade: { id: `nh-${r.id}`, side: r.side, entry: r.entry, stop: r.stop, openedAt, maxHoldMs: MAX_HOLD_MS[r.htf] },
        group: groupsOf(r.side, passes, r.risk_pct), sets: setsOf(r.side, passes, checks), candles,
        row: { symbol, side: r.side, setup: r.setup, openedAt: r.opened_at.toISOString(), today: r.side === "long" ? passes : null, smc: checks },
      });
    }
  }
  return { items, symbols: bySymbol.size, skipped, smcUnknown };
}

// ---------- history ----------
type Data = Record<Exclude<Interval, "5m">, Candle[]>;
export type HistoryData = Data;

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
const TAKE5 = variants().find((m) => m.id === "take5")!;

/** Every live trade, newest first, with its result by Nihilist's management and by a fixed +5% take. */
export function liveTradeRows(items: Item[]): LiveTradeRow[] {
  const out: LiveTradeRow[] = [];
  for (const it of items) {
    if (!it.row) continue;
    const a = simulate(it.trade, it.candles, SPAN, SOURCE), b = simulate(it.trade, it.candles, SPAN, TAKE5);
    out.push({
      ...it.row,
      source: { pnlPct: a.pnlPct, reason: a.closed ? a.reason : null },
      take5: { pnlPct: b.pnlPct, reason: b.closed ? b.reason : null },
    });
  }
  return out.sort((x, y) => y.openedAt.localeCompare(x.openedAt));
}
const prio = (s: SetupSignal) => SETUP_PRIORITY.indexOf(`${s.htf}_${s.ltf}`);

/** Every setup signal of one coin over the last HISTORY_DAYS, in time order (best setup first). */
export function allSignals(data: Data, now = Date.now()): SetupSignal[] {
  const from = now - HISTORY_DAYS * 86_400_000;
  const all: SetupSignal[] = [];
  for (const combo of COMBOS) {
    const { signals } = evaluateSetups({ htf: combo.htf, ltf: combo.ltf, htfCandles: data[combo.htf], ltfCandles: data[combo.ltf] });
    all.push(...signals.filter((s) => s.signalAt >= from));
  }
  return all.sort((a, b) => a.signalAt - b.signalAt || prio(a) - prio(b));
}

/** Signals of one coin as live: one open trade per side (by Nihilist's own management), best setup first. */
export function historySignals(symbol: string, data: Data, all: SetupSignal[] = allSignals(data)): Item[] {
  // One open trade per coin and side. Longs are followed twice: every long ("long_all") and only the
  // longs that pass today's filter ("long_filtered") — a failed long never blocks a filtered one.
  // Each SMC rule set is its own stream too.
  const busy: Record<string, number> = emptyGroups(() => 0);
  for (const f of FILTER_SETS) busy[`f:${f.id}`] = 0;
  const items: Item[] = [];
  for (const s of all) {
    const passes = s.side === "short" || entryFilter({
      side: s.side, riskPct: s.riskPct, entry: s.entry, blockTop: s.block.top, blockBottom: s.block.bottom,
      signalAt: s.signalAt, blockCreatedAt: s.block.createdAt ?? null, blockTime: s.block.time ?? null,
    }).pass;
    const group = groupsOf(s.side, passes, s.riskPct).filter((g) => s.signalAt >= busy[g]!);
    const sets = setsOf(s.side, passes, s.smc).filter((f) => s.signalAt >= busy[`f:${f}`]!);
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
    const rows = await liveRows();
    const liveSymbols = new Set(rows.map((r) => r.symbol));
    const withHistory = opts.history !== false;
    const universe = withHistory ? await getUniverse() : [];
    if (!universe) throw new Error("CoinGlass: список монет не получен");
    const inUniverse = new Set(universe.map((u) => u.instrumentId));
    // Every coin of the backtest, plus live coins no longer listed (their SMC conditions only).
    const symbols = [...inUniverse, ...[...liveSymbols].filter((s) => !inUniverse.has(s))];
    const acc = new Acc();
    const smc = new Map<string, SmcChecks>();
    let skipped = 0;
    report.progress = { stage: "history", done: 0, total: symbols.length };
    for (const [i, symbol] of symbols.entries()) {
      const data = await history(symbol).catch(() => null);
      if (!data) { if (inUniverse.has(symbol)) skipped += 1; }
      else {
        const all = allSignals(data);
        if (liveSymbols.has(symbol)) for (const s of all) smc.set(smcKey(symbol, s.setup, s.barTime), s.smc);
        if (inUniverse.has(symbol)) for (const it of historySignals(symbol, data, all)) acc.add(it);
      }
      if ((i + 1) % 10 === 0 || i + 1 === symbols.length) {
        report.progress = { stage: "history", done: i + 1, total: symbols.length };
        await save(report);
      }
      await new Promise((r) => setImmediate(r));
    }
    const live = await liveItems(rows, smc);
    const liveAcc = new Acc();
    for (const it of live.items) liveAcc.add(it);
    const liveDs = liveAcc.report("live", live.symbols, live.skipped, live.smcUnknown);
    liveDs.tradeList = liveTradeRows(live.items);
    report.datasets.push(liveDs);
    report.parity = await parityCheck(live.items);
    if (withHistory) report.datasets.push(acc.report("history", universe.length - skipped, skipped));
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
/** 60-day candle history of a coin (also the SMC study, owner 2026-11-10). */
export const loadHistory = (symbol: string) => history(symbol);

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
