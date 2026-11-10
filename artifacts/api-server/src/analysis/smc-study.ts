/**
 * SMC study (owner 2026-11-10): two classic SMC rules the bot does not use, on the same signals —
 *   6. refined entry: after the CHoCH wait for a retest instead of entering at the close of the break bar —
 *      the LTF order block of the break (LuxAlgo internal OB of the CHoCH), the last fair value gap of the
 *      break leg, or 50% of the leg (equilibrium); waiting 2, 4 or 8 LTF bars, no retest = no trade;
 *   7. targets at liquidity: the whole position closed at the nearest unbroken LTF swing level, the nearest
 *      unbroken HTF swing level (the old TP1), equal highs/lows (two LTF swing levels within 0.15%), or half at
 *      the LTF level and the rest by today's management or at the HTF level.
 * Every entry × every exit (10 × 6) on the 60-day history of every BingX pair (one trade per coin and side,
 * as the trading bot; longs only when they pass today's entry filter) and on the live signals by name.
 * The stop is the signal's structural stop in every variant; break-even +5% in every variant.
 * 30m candles inside a trade: the stop in force at a candle's start goes first (conservative, as the bot).
 * Read-only: it never changes signals, trades or settings. Result in nh_state "smc_study" + a CSV in /tmp.
 */
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { INTERVAL_MS, type Candle } from "../engine/candles";
import { MAX_HOLD_MS, entryFilter } from "../engine/config";
import { SmcEngine, type PivotPoint } from "../engine/smc";
import { unbrokenLevels, type SetupSignal } from "../engine/setups";
import { getUniverse } from "../market/coinglass";
import { logger } from "../lib/logger";
import { allSignals, loadHistory, HISTORY_DAYS, type HistoryData } from "./strategy-report";
import { simulate, stats, type Mgmt, type Row, type SimResult, type Stats } from "./strategy-sim";

const KEY = "smc_study";
const SPAN = INTERVAL_MS["30m"];
export const SMC_STUDY_CSV = "/tmp/nh-smc-study.csv";

// ---------------- variants ----------------
export type EntryKind = "cur" | "ob" | "fvg" | "eq";
export const ENTRIES: Array<{ id: string; kind: EntryKind; wait: number; label: string }> = [
  { id: "cur", kind: "cur", wait: 0, label: "сейчас: закрытие свечи слома" },
  ...([2, 4, 8] as const).flatMap((w) => [
    { id: `ob_w${w}`, kind: "ob" as const, wait: w, label: `ретест ОБ младшего ТФ, ждём ${w} свечи` },
    { id: `fvg_w${w}`, kind: "fvg" as const, wait: w, label: `ретест FVG движения слома, ждём ${w} свечи` },
    { id: `eq_w${w}`, kind: "eq" as const, wait: w, label: `50% движения слома, ждём ${w} свечи` },
  ]),
];
export type ExitKind = "cur" | "ltf" | "htf" | "eqhl" | "half_ltf_cur" | "half_ltf_htf";
export const EXITS: Array<{ id: ExitKind; label: string }> = [
  { id: "cur", label: "сейчас: шорт тейк +8%, лонг трейлинг с +15%" },
  { id: "ltf", label: "вся позиция на ближайшей ликвидности младшего ТФ" },
  { id: "htf", label: "вся позиция на ближайшей ликвидности старшего ТФ (старый тейк 1)" },
  { id: "eqhl", label: "вся позиция на equal highs / lows" },
  { id: "half_ltf_cur", label: "50% на ликвидности младшего ТФ, остаток как сейчас" },
  { id: "half_ltf_htf", label: "50% на ликвидности младшего ТФ, остаток на ликвидности старшего ТФ" },
];
const EQ_TOLERANCE = 0.0015;

const mk = (id: string, p: Partial<Omit<Mgmt, "id" | "label">>): Mgmt =>
  ({ id, label: id, be: p.be ?? null, take: p.take ?? null, partial: p.partial ?? null, trail: p.trail ?? null });
/** Today's management of a side (engine/config.ts). */
export const currentMgmt = (side: "long" | "short"): Mgmt =>
  side === "short" ? mk("cur", { be: 5, take: 8 }) : mk("cur", { be: 5, trail: { act: 15, gap: 10 } });

/** Management of an exit variant for a trade entered at `entry`; null when the target does not exist. */
export function exitMgmt(kind: ExitKind, side: "long" | "short", entry: number, t: Targets): Mgmt | null {
  const pct = (level: number | null) => (level === null ? null : ((level - entry) / entry) * 100 * (side === "long" ? 1 : -1));
  const ok = (p: number | null): p is number => p !== null && p > 0.3;
  const ltf = pct(t.ltf), htf = pct(t.htf), eq = pct(t.eqhl);
  const cur = currentMgmt(side);
  switch (kind) {
    case "cur": return cur;
    case "ltf": return ok(ltf) ? mk(kind, { be: 5, take: ltf }) : null;
    case "htf": return ok(htf) ? mk(kind, { be: 5, take: htf }) : null;
    case "eqhl": return ok(eq) ? mk(kind, { be: 5, take: eq }) : null;
    case "half_ltf_cur": return ok(ltf) ? { ...cur, id: kind, partial: { at: ltf, share: 0.5 } } : null;
    case "half_ltf_htf": return ok(ltf) && ok(htf) && htf > ltf ? mk(kind, { be: 5, partial: { at: ltf, share: 0.5 }, take: htf }) : null;
  }
}

// ---------------- signal geometry (no lookahead: everything is known at the signal) ----------------
export type Targets = { ltf: number | null; htf: number | null; eqhl: number | null };
export type Zones = { ob: number | null; fvg: number | null; eq: number | null };

/** Last fair value gap of the break leg, as a limit price (long: the gap's top edge). */
export function lastFvg(ltf: Candle[], from: number, to: number, side: "long" | "short"): number | null {
  for (let i = to; i >= Math.max(from + 2, 2); i--) {
    if (side === "long" && ltf[i - 2].h < ltf[i].l) return ltf[i].l;
    if (side === "short" && ltf[i - 2].l > ltf[i].h) return ltf[i].h;
  }
  return null;
}

/** Equal highs (long) / lows (short): two unbroken swing levels within EQ_TOLERANCE — the nearest beyond entry. */
export function equalLevel(levels: number[], entry: number, side: "long" | "short"): number | null {
  const beyond = levels.filter((l) => (side === "long" ? l > entry : l < entry)).sort((a, b) => (side === "long" ? a - b : b - a));
  for (let i = 0; i + 1 < beyond.length; i++) {
    const a = beyond[i]!, b = beyond[i + 1]!;
    if (Math.abs(a - b) / a <= EQ_TOLERANCE) return side === "long" ? Math.max(a, b) : Math.min(a, b);
  }
  return null;
}

type LtfState = { engine: SmcEngine; index: number; chochOb: Map<number, { top: number; bottom: number; dir: 1 | -1 }> };

/** Walks the LTF series once; for every bar remembers the internal CHoCH order block, if any. */
function ltfWalk(ltf: Candle[]): { snaps: Map<number, { highs: PivotPoint[]; lows: PivotPoint[]; index: number }>; chochOb: LtfState["chochOb"] } {
  const engine = new SmcEngine();
  const snaps = new Map<number, { highs: PivotPoint[]; lows: PivotPoint[]; index: number }>();
  const chochOb: LtfState["chochOb"] = new Map();
  for (const [index, bar] of ltf.entries()) {
    for (const e of engine.push(bar)) {
      if (e.kind === "CHOCH" && e.scope === "internal" && e.orderBlock) chochOb.set(bar.t, { top: e.orderBlock.top, bottom: e.orderBlock.bottom, dir: e.dir });
    }
    const s = engine.snapshot();
    snaps.set(bar.t, { highs: s.pivotHighs, lows: s.pivotLows, index });
  }
  return { snaps, chochOb };
}

/** Test hook: the LTF walk used by geometry(). */
export const __walkForTest = (ltf: Candle[]) => ltfWalk(ltf);

export function geometry(s: SetupSignal, ltf: Candle[], walk: ReturnType<typeof ltfWalk>): { zones: Zones; targets: Targets } {
  const snap = walk.snaps.get(s.barTime);
  const idx = snap?.index ?? ltf.findIndex((c) => c.t === s.barTime);
  const dir = s.side === "long" ? 1 : -1;
  // Break leg: from the reaction extreme (since the first touch) to the CHoCH bar.
  let start = idx;
  for (let i = idx; i >= 0 && ltf[i]!.t >= s.firstTouchAt; i--) {
    if ((s.side === "long" ? ltf[i]!.l : ltf[i]!.h) === s.extreme) { start = i; break; }
  }
  let far = s.side === "long" ? -Infinity : Infinity;
  for (let i = start; i <= idx; i++) far = s.side === "long" ? Math.max(far, ltf[i]!.h) : Math.min(far, ltf[i]!.l);
  const ob = walk.chochOb.get(s.barTime);
  const obLimit = ob && ob.dir === dir ? (s.side === "long" ? ob.top : ob.bottom) : null;
  const zones: Zones = {
    ob: obLimit,
    fvg: idx >= 0 ? lastFvg(ltf, start, idx, s.side) : null,
    eq: Number.isFinite(far) ? (s.extreme + far) / 2 : null,
  };
  const pivots = snap ? (s.side === "long" ? snap.highs : snap.lows) : [];
  const levels = idx >= 0 ? unbrokenLevels(pivots, ltf, idx, s.side) : [];
  const beyond = levels.filter((l) => (s.side === "long" ? l > s.entry : l < s.entry));
  return {
    zones,
    targets: {
      ltf: beyond[0] ?? null,
      htf: s.targetsSource === "structure" ? s.tp1 : null,
      eqhl: equalLevel(levels, s.entry, s.side),
    },
  };
}

// ---------------- one trade ----------------
export type Fill = { filled: boolean; at: number; price: number; barsWaited: number };

/** Limit fill on 30m candles within `waitBars` LTF bars after the signal; a better-than-close limit only. */
export function fillLimit(s: { side: "long" | "short"; entry: number; signalAt: number }, limit: number | null, waitMs: number, m30: Candle[]): Fill {
  const none: Fill = { filled: false, at: 0, price: 0, barsWaited: 0 };
  if (limit === null || !Number.isFinite(limit)) return none;
  const better = s.side === "long" ? limit < s.entry : limit > s.entry;
  if (!better) return { filled: true, at: s.signalAt, price: s.entry, barsWaited: 0 }; // still at the zone: enter now
  let k = 0;
  for (const c of m30) {
    if (c.t < s.signalAt) continue;
    if (c.t >= s.signalAt + waitMs) break;
    k += 1;
    const touched = s.side === "long" ? c.l <= limit : c.h >= limit;
    if (touched) {
      const price = s.side === "long" ? Math.min(limit, c.o) : Math.max(limit, c.o);
      return { filled: true, at: c.t, price, barsWaited: k };
    }
  }
  return none;
}

/**
 * A trade from its fill. Entry at the signal (barsWaited 0): followed from the signal on. A limit filled inside a
 * later candle: that candle may also have hit the stop (checked first, conservative); otherwise the trade is
 * followed from the next candle.
 */
export function runTrade(side: "long" | "short", fill: Fill, stop: number, maxHoldMs: number, m30: Candle[], m: Mgmt): SimResult {
  if (fill.barsWaited === 0) return simulate({ id: "", side, entry: fill.price, stop, openedAt: fill.at, maxHoldMs }, m30, SPAN, m);
  const dir = side === "long" ? 1 : -1;
  const bar = m30.find((c) => c.t === fill.at);
  if (bar && (dir === 1 ? bar.l <= stop : bar.h >= stop)) {
    const pnl = ((stop - fill.price) / fill.price) * 100 * dir - 0.1;
    return { closed: true, reason: "stop", closedAt: fill.at + SPAN, pnlPct: Math.round(pnl * 1000) / 1000, peakPct: 0, holdH: 0.5 };
  }
  return simulate({ id: "", side, entry: fill.price, stop, openedAt: fill.at + SPAN, maxHoldMs }, m30, SPAN, m);
}

// ---------------- the run ----------------
type Cell = { rows: Row[]; open: number; signals: number; filled: number; missedWinners: number; missedSum: number; riskSum: number; noTarget: number };
type Acc = Record<string, Cell>; // key `${dataset}|${side}|${entry}|${exit}`
const cell = (acc: Acc, k: string): Cell => (acc[k] ??= { rows: [], open: 0, signals: 0, filled: 0, missedWinners: 0, missedSum: 0, riskSum: 0, noTarget: 0 });

export type StudyRow = {
  dataset: string; side: string; entry: string; exit: string; signals: number; filledPct: number; noTargetPct: number;
  avgRiskPct: number; missedWinners: number; missedSumPct: number; stats: Stats;
};
export type StudyReport = {
  status: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; error: string | null;
  progress: { done: number; total: number }; rows: StudyRow[]; liveMatched: number; liveTotal: number;
};

let running = false;
export const smcStudyRunning = () => running;

async function save(r: StudyReport): Promise<void> {
  await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify(r)]);
}
export async function loadSmcStudy(): Promise<StudyReport | null> {
  const { rows } = await pool.query<{ value: StudyReport }>("SELECT value FROM nh_state WHERE key = $1", [KEY]);
  const r = rows[0]?.value ?? null;
  return r && r.status === "running" && !running ? { ...r, status: "failed", error: "расчёт прерван перезапуском сервера — запустите заново" } : r;
}

/** ATR(14) of closed 1H candles at the signal, % of the last close (the long entry filter's measure). */
export function atrPct1h(h1: Candle[], at: number): number | null {
  const closed = h1.filter((c) => c.t + INTERVAL_MS["1h"] <= at).slice(-15);
  if (closed.length < 15) return null;
  let tr = 0;
  for (let i = 1; i < closed.length; i++) {
    const c = closed[i]!, p = closed[i - 1]!;
    tr += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return (tr / 14 / closed[closed.length - 1]!.c) * 100;
}

const CSV_HEAD = ["dataset", "symbol", "side", "setup", "signal_at", "live", "risk_pct", "tgt_ltf_pct", "tgt_htf_pct", "tgt_eqhl_pct"];

export async function runSmcStudy(): Promise<void> {
  if (running) return;
  running = true;
  const report: StudyReport = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null, progress: { done: 0, total: 0 }, rows: [], liveMatched: 0, liveTotal: 0 };
  const acc: Acc = {};
  const csv: string[] = [[...CSV_HEAD, ...ENTRIES.flatMap((e) => [`${e.id}_filled`, ...EXITS.map((x) => `${e.id}__${x.id}`)])].join(",")];
  try {
    await save(report);
    const { rows: liveRows } = await pool.query<{ symbol: string; setup: string; bar_time: string }>(
      "SELECT symbol, setup, bar_time FROM nh_signals WHERE live AND opened_at > now() - make_interval(days => $1)", [HISTORY_DAYS]);
    const liveKeys = new Set(liveRows.map((r) => `${r.symbol}|${r.setup}|${Number(r.bar_time)}`));
    report.liveTotal = liveKeys.size;
    const universe = await getUniverse();
    if (!universe) throw new Error("CoinGlass: список монет не получен");
    const symbols = [...new Set([...universe.map((u) => u.instrumentId), ...liveRows.map((r) => r.symbol)])];
    report.progress = { done: 0, total: symbols.length };
    for (const [i, symbol] of symbols.entries()) {
      const data = await loadHistory(symbol).catch(() => null);
      if (data) studySymbol(symbol, data, liveKeys, acc, csv, report);
      if ((i + 1) % 10 === 0 || i + 1 === symbols.length) { report.progress = { done: i + 1, total: symbols.length }; await save(report); }
      await new Promise((r) => setImmediate(r));
    }
    report.rows = Object.entries(acc).map(([k, c]) => {
      const [dataset, side, entry, exit] = k.split("|") as [string, string, string, string];
      return {
        dataset, side, entry, exit, signals: c.signals,
        filledPct: c.signals ? Math.round((1000 * c.filled) / c.signals) / 10 : 0,
        noTargetPct: c.filled ? Math.round((1000 * c.noTarget) / c.filled) / 10 : 0,
        avgRiskPct: c.filled ? Math.round((100 * c.riskSum) / c.filled) / 100 : 0,
        missedWinners: c.missedWinners, missedSumPct: Math.round(c.missedSum * 10) / 10,
        stats: stats(c.rows, c.open),
      };
    });
    writeFileSync(SMC_STUDY_CSV, csv.join("\n"));
    report.status = "done";
    report.finishedAt = new Date().toISOString();
    await save(report);
  } catch (err) {
    logger.warn({ err }, "nihilist: SMC study failed");
    report.status = "failed"; report.error = err instanceof Error ? err.message : String(err); report.finishedAt = new Date().toISOString();
    await save(report).catch(() => undefined);
  } finally {
    running = false;
  }
}

/** One coin: its signals as the trading bot would take them (one trade per side), every entry × exit. */
export function studySymbol(symbol: string, data: HistoryData, liveKeys: Set<string>, acc: Acc, csv: string[], report: StudyReport, now = Date.now()): void {
  const all = allSignals(data, now);
  const walks = { "30m": ltfWalk(data["30m"]), "1h": ltfWalk(data["1h"]) };
  const busy = { long: 0, short: 0 };
  const m30 = data["30m"];
  for (const s of all) {
    const live = liveKeys.has(`${symbol}|${s.setup}|${s.barTime}`);
    // History: one trade per coin and side, as the trading bot. A live signal is always studied by name.
    const inHistory = s.signalAt >= busy[s.side];
    if (!inHistory && !live) continue;
    if (s.side === "long" && !entryFilter({
      side: "long", riskPct: s.riskPct, entry: s.entry, blockTop: s.block.top, blockBottom: s.block.bottom, signalAt: s.signalAt,
      blockCreatedAt: s.block.createdAt ?? null, blockTime: s.block.time ?? null, atrPct1h: atrPct1h(data["1h"], s.signalAt),
    }).pass) continue;
    const maxHoldMs = MAX_HOLD_MS[s.htf];
    const window = m30.filter((c) => c.t >= s.signalAt - SPAN && c.t <= s.signalAt + maxHoldMs + 9 * INTERVAL_MS[s.ltf] + SPAN);
    const ltf = data[s.ltf];
    const { zones, targets } = geometry(s, ltf, walks[s.ltf]);
    if (live) report.liveMatched += 1;
    // The stream is busy until the trade by today's rules closes (as the trading bot: one trade per coin and side).
    const base = runTrade(s.side, { filled: true, at: s.signalAt, price: s.entry, barsWaited: 0 }, s.stop, maxHoldMs, window, currentMgmt(s.side));
    if (inHistory) busy[s.side] = base.closed ? base.closedAt! : Infinity;
    const datasets = [...(inHistory ? ["history"] : []), ...(live ? ["live"] : [])];
    const pct = (lv: number | null) => (lv === null ? "" : (((lv - s.entry) / s.entry) * 100 * (s.side === "long" ? 1 : -1)).toFixed(2));
    const line: string[] = [datasets.join("+"), symbol, s.side, s.setup, new Date(s.signalAt).toISOString(), live ? "1" : "0",
      s.riskPct.toFixed(2), pct(targets.ltf), pct(targets.htf), pct(targets.eqhl)];
    for (const e of ENTRIES) {
      const limit = e.kind === "cur" ? s.entry : zones[e.kind];
      const fill = e.kind === "cur"
        ? { filled: true, at: s.signalAt, price: s.entry, barsWaited: 0 }
        : fillLimit(s, limit, e.wait * INTERVAL_MS[s.ltf], window);
      line.push(fill.filled ? String(fill.barsWaited) : "");
      for (const x of EXITS) {
        const m = fill.filled ? exitMgmt(x.id, s.side, fill.price, targets) : null;
        const r = fill.filled && m ? runTrade(s.side, fill, s.stop, maxHoldMs, window, m) : null;
        for (const ds of datasets) {
          const c = cell(acc, `${ds}|${s.side}|${e.id}|${x.id}`);
          c.signals += 1;
          if (!fill.filled) {
            if (base.closed && base.pnlPct > 0) { c.missedWinners += 1; c.missedSum += base.pnlPct; }
            continue;
          }
          c.filled += 1;
          c.riskSum += (Math.abs(fill.price - s.stop) / fill.price) * 100;
          if (!r) { c.noTarget += 1; continue; }
          if (!r.closed) { c.open += 1; continue; }
          c.rows.push({ tradeId: `${symbol}:${s.setup}:${s.signalAt}`, openedAt: s.signalAt, closedAt: r.closedAt!, pnlPct: r.pnlPct, reason: r.reason!, holdH: r.holdH, peakPct: r.peakPct });
        }
        line.push(!fill.filled ? "" : !r ? "n/a" : r.closed ? r.pnlPct.toFixed(2) : "open");
      }
    }
    csv.push(line.join(","));
  }
}

// ---------------- text ----------------
const sg = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
export function smcStudyText(r: StudyReport): string {
  const out = [`Нигилист — SMC: уточнённый вход и цели по ликвидности, расчёт ${r.finishedAt ?? "—"}`,
    `Живых сигналов за ${HISTORY_DAYS} дней: ${r.liveTotal}, найдено в бэктесте: ${r.liveMatched}`,
    "Колонки: вход | выход | сигналов | вход исполнен % | без цели % | ср. стоп % | сделок (откр.) | плюс % | стоп % | ср. % | сумма % | ср. % маржи 10x | PF | 1-я пол. ср. | 2-я пол. ср. | упущено прибыльных (сумма %)",
    "Входы: " + ENTRIES.map((e) => `${e.id} = ${e.label}`).join("; "),
    "Выходы: " + EXITS.map((x) => `${x.id} = ${x.label}`).join("; ")];
  for (const ds of ["live", "history"]) for (const side of ["short", "long"]) {
    const rows = r.rows.filter((x) => x.dataset === ds && x.side === side).sort((a, b) => b.stats.sum - a.stats.sum);
    if (!rows.length) continue;
    out.push("", `=== ${ds === "live" ? "Реальные сигналы" : `Бэктест ${HISTORY_DAYS} дней`} · ${side === "short" ? "шорты" : "лонги (фильтр сейчас)"}`);
    for (const x of rows) {
      const s = x.stats;
      out.push([x.entry, x.exit, x.signals, x.filledPct, x.noTargetPct, x.avgRiskPct, `${s.n} (${s.open})`, Math.round(s.winPct), Math.round(s.stopPct),
        sg(s.avg), sg(s.sum, 0), sg(s.avg * 10, 1), s.pf ?? "—", sg(s.half1.avg), sg(s.half2.avg), `${x.missedWinners} (${sg(x.missedSumPct, 0)})`].join(" | "));
    }
  }
  return out.join("\n");
}
