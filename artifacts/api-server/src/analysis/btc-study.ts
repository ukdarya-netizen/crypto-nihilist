/**
 * BTC study (owner 2026-11-10): BTC cannot be managed with the altcoin percentages (stop +3% beyond the structure,
 * break-even +5%, short take +8%, long trailing from +15%) — it moves several times less. This study finds BTC's
 * own rules on its long history (up to 2 years of CoinGlass candles), all 8 Nihilist setups, longs and shorts:
 *   - stop pad beyond the structural stop: 0, 0.25, 0.5, 1, 1.5, 2, 3 (today) %;
 *   - exits: break-even none / +0.5 / +1 / +1.5 / +2 / +3 % × take +1 … +8 %, trailing (start / gap),
 *     targets in R (risk multiples), and today's altcoin rules for reference.
 * One trade per side at a time (as the bot). 30m candles; the stop in force at a candle's start goes first.
 * At 50x (the trading bot's BTC leverage) the margin result is shown too, with how many stops were beyond the
 * liquidation price (≈ 2% from entry). ETH is computed the same way for comparison. Read-only.
 */
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { INTERVAL_MS, type Candle, type Interval } from "../engine/candles";
import { COMBOS, MAX_HOLD_MS } from "../engine/config";
import { evaluateSetups, type SetupSignal } from "../engine/setups";
import { SETUP_PRIORITY } from "../engine/runtime";
import { getCandleHistory, waitForScanIdle } from "../market/coinglass";
import { logger } from "../lib/logger";
import { simulate, stats, type Mgmt, type Row, type Stats } from "./strategy-sim";

const KEY = "btc_study";
const SPAN = INTERVAL_MS["30m"];
export const BTC_STUDY_CSV = "/tmp/nh-btc-study.csv";
export const BTC_STUDY_SYMBOLS = ["BTC-USDT", "ETH-USDT"];
export const HISTORY_DAYS_BTC = 730;
export const STOP_PADS = [0, 0.25, 0.5, 1, 1.5, 2, 3];
/** Liquidation distance at 50x isolated, % of entry (1/50 minus the maintenance margin). */
export const LIQ_50X_PCT = 1.6;

type Data = Record<Exclude<Interval, "5m">, Candle[]>;
type Exit = { id: string; label: string; mgmt: (risk: number, side: "long" | "short") => Mgmt };

const mk = (id: string, p: Partial<Omit<Mgmt, "id" | "label">>): Mgmt =>
  ({ id, label: id, be: p.be ?? null, take: p.take ?? null, partial: p.partial ?? null, trail: p.trail ?? null });

export function exits(): Exit[] {
  const out: Exit[] = [{
    id: "alt_rules", label: "как у альтов сейчас: БУ +5%, шорт тейк +8%, лонг трейлинг с +15%",
    mgmt: (_r, side) => (side === "short" ? mk("alt_rules", { be: 5, take: 8 }) : mk("alt_rules", { be: 5, trail: { act: 15, gap: 10 } })),
  }];
  for (const be of [null, 0.5, 1, 1.5, 2, 3]) {
    for (const take of [1, 1.5, 2, 3, 4, 5, 6, 8]) {
      if (be !== null && be >= take) continue;
      const id = `${be === null ? "nobe" : `be${be}`}_take${take}`;
      out.push({ id, label: `${be === null ? "без БУ" : `БУ +${be}%`}, тейк +${take}%`, mgmt: () => mk(id, { be, take }) });
    }
    for (const [act, gap] of [[2, 1], [3, 1.5], [4, 2], [5, 2.5], [6, 3], [8, 4]] as const) {
      if (be !== null && be >= act) continue;
      const id = `${be === null ? "nobe" : `be${be}`}_trail${act}_${gap}`;
      out.push({ id, label: `${be === null ? "без БУ" : `БУ +${be}%`}, трейлинг с +${act}% (пик − ${gap} п.п.)`, mgmt: () => mk(id, { be, trail: { act, gap } }) });
    }
  }
  for (const k of [1, 1.5, 2, 3]) {
    for (const beR of [null, 0.5, 1]) {
      if (beR !== null && beR >= k) continue;
      const id = `r${k}${beR === null ? "" : `_be${beR}r`}`;
      out.push({ id, label: `тейк ${k}R${beR === null ? "" : `, БУ на ${beR}R`}`, mgmt: (risk) => mk(id, { take: k * risk, be: beR === null ? null : beR * risk }) });
    }
  }
  out.push({ id: "half1r_trail", label: "50% на 1R, БУ, остаток трейлинг с 2R (пик − 1R)", mgmt: (risk) => mk("half1r_trail", { partial: { at: risk, share: 0.5 }, trail: { act: 2 * risk, gap: risk } }) });
  return out;
}

export type BtcRow = {
  symbol: string; side: "long" | "short"; pad: number; exit: string; label: string;
  avgRiskPct: number; liqStops: number; stats: Stats; margin50Avg: number; margin10Avg: number;
};
export type BtcReport = {
  status: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; error: string | null;
  progress: { done: number; total: number; stage: string };
  ranges: Array<{ symbol: string; from: string | null; to: string | null; bars30m: number; signals: number }>;
  rows: BtcRow[];
};

let running = false;
export const btcStudyRunning = () => running;

async function save(r: BtcReport): Promise<void> {
  await pool.query(
    `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify(r)]);
}
export async function loadBtcStudy(): Promise<BtcReport | null> {
  const { rows } = await pool.query<{ value: BtcReport }>("SELECT value FROM nh_state WHERE key = $1", [KEY]);
  const r = rows[0]?.value ?? null;
  return r && r.status === "running" && !running ? { ...r, status: "failed", error: "расчёт прерван перезапуском сервера — запустите заново" } : r;
}

async function loadLong(symbol: string): Promise<Data | null> {
  const want: Record<keyof Data, number> = {
    "30m": HISTORY_DAYS_BTC * 48 + 400, "1h": HISTORY_DAYS_BTC * 24 + 400, "4h": HISTORY_DAYS_BTC * 6 + 700, "1d": HISTORY_DAYS_BTC + 500,
  };
  const out = {} as Data;
  for (const interval of Object.keys(want) as Array<keyof Data>) {
    await waitForScanIdle();
    const candles = await getCandleHistory(symbol, interval, want[interval]);
    if (!candles || candles.length < 200) return null;
    out[interval] = candles.filter((c) => c.t + INTERVAL_MS[interval] <= Date.now());
  }
  return out;
}

const prio = (s: SetupSignal) => SETUP_PRIORITY.indexOf(`${s.htf}_${s.ltf}`);

/** All setups of a coin with a given stop pad, best setup first within a bar. */
export function signalsWithPad(data: Data, pad: number, from: number): SetupSignal[] {
  const all: SetupSignal[] = [];
  for (const combo of COMBOS) {
    const { signals } = evaluateSetups({
      htf: combo.htf, ltf: combo.ltf, htfCandles: data[combo.htf], ltfCandles: data[combo.ltf], options: { stopExtraPct: pad },
    });
    all.push(...signals.filter((s) => s.signalAt >= from));
  }
  return all.sort((a, b) => a.signalAt - b.signalAt || prio(a) - prio(b));
}

type Cell = { rows: Row[]; open: number; risk: number[]; liq: number };

/** One coin, one stop pad: every exit as its own stream (one trade per side at a time). */
export function studyPad(symbol: string, data: Data, pad: number, from: number, acc: Map<string, Cell>, csv: string[]): number {
  const signals = signalsWithPad(data, pad, from);
  const m30 = data["30m"];
  // Candle window of each signal, cut once (binary search) — 2 years of 30m bars are ~35k.
  const lowerBound = (t: number) => { let lo = 0, hi = m30.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (m30[mid]!.t < t) lo = mid + 1; else hi = mid; } return lo; };
  const windows = signals.map((s) => m30.slice(lowerBound(s.signalAt - SPAN), lowerBound(s.signalAt + MAX_HOLD_MS[s.htf] + 2 * SPAN)));
  for (const x of exits()) {
    const busy = { long: 0, short: 0 };
    for (const [i, s] of signals.entries()) {
      if (s.signalAt < busy[s.side]) continue;
      const maxHoldMs = MAX_HOLD_MS[s.htf];
      const window = windows[i]!;
      const m = x.mgmt(s.riskPct, s.side);
      const r = simulate({ id: "", side: s.side, entry: s.entry, stop: s.stop, openedAt: s.signalAt, maxHoldMs }, window, SPAN, m);
      busy[s.side] = r.closed ? r.closedAt! : Infinity;
      const key = `${symbol}|${s.side}|${pad}|${x.id}`;
      const c = acc.get(key) ?? { rows: [], open: 0, risk: [], liq: 0 };
      acc.set(key, c);
      c.risk.push(s.riskPct);
      if (!r.closed) { c.open += 1; continue; }
      if (r.reason === "stop" && s.riskPct > LIQ_50X_PCT) c.liq += 1;
      c.rows.push({ tradeId: `${symbol}:${s.setup}:${s.signalAt}`, openedAt: s.signalAt, closedAt: r.closedAt!, pnlPct: r.pnlPct, reason: r.reason!, holdH: r.holdH, peakPct: r.peakPct });
      csv.push([symbol, s.side, s.setup, new Date(s.signalAt).toISOString(), pad, x.id, s.riskPct.toFixed(2), r.pnlPct.toFixed(3), r.reason, r.peakPct.toFixed(2), r.holdH.toFixed(1)].join(","));
    }
  }
  return signals.length;
}

export function buildRows(acc: Map<string, Cell>): BtcRow[] {
  const labels = new Map(exits().map((x) => [x.id, x.label]));
  return [...acc.entries()].map(([k, c]) => {
    const [symbol, side, pad, exit] = k.split("|") as [string, "long" | "short", string, string];
    const st = stats(c.rows, c.open);
    return {
      symbol, side, pad: Number(pad), exit, label: labels.get(exit) ?? exit,
      avgRiskPct: c.risk.length ? Math.round((100 * c.risk.reduce((a, b) => a + b, 0)) / c.risk.length) / 100 : 0,
      liqStops: c.liq, stats: st,
      margin50Avg: Math.round(st.avg * 50 * 10) / 10, margin10Avg: Math.round(st.avg * 10 * 10) / 10,
    };
  });
}

export async function runBtcStudy(): Promise<void> {
  if (running) return;
  running = true;
  const report: BtcReport = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null, progress: { done: 0, total: BTC_STUDY_SYMBOLS.length * STOP_PADS.length, stage: "candles" }, ranges: [], rows: [] };
  const acc = new Map<string, Cell>();
  const csv = ["symbol,side,setup,signal_at,stop_pad_pct,exit,risk_pct,pnl_pct,reason,peak_pct,hold_h"];
  try {
    await save(report);
    for (const symbol of BTC_STUDY_SYMBOLS) {
      report.progress.stage = `${symbol}: свечи`;
      await save(report);
      const data = await loadLong(symbol);
      if (!data) { report.ranges.push({ symbol, from: null, to: null, bars30m: 0, signals: 0 }); continue; }
      const m30 = data["30m"];
      // Setups need warm-up: signals only from the 400th 30m bar on.
      const from = m30[Math.min(400, m30.length - 1)]!.t;
      let signals = 0;
      for (const pad of STOP_PADS) {
        report.progress.stage = `${symbol}: стоп +${pad}%`;
        signals = Math.max(signals, studyPad(symbol, data, pad, from, acc, csv));
        report.progress.done += 1;
        await save(report);
        await new Promise((r) => setImmediate(r));
      }
      report.ranges.push({ symbol, from: new Date(from).toISOString(), to: new Date(m30[m30.length - 1]!.t).toISOString(), bars30m: m30.length, signals });
    }
    report.rows = buildRows(acc);
    writeFileSync(BTC_STUDY_CSV, csv.join("\n"));
    report.status = "done";
    report.finishedAt = new Date().toISOString();
    await save(report);
  } catch (err) {
    logger.warn({ err }, "nihilist: BTC study failed");
    report.status = "failed"; report.error = err instanceof Error ? err.message : String(err); report.finishedAt = new Date().toISOString();
    await save(report).catch(() => undefined);
  } finally {
    running = false;
  }
}

const sg = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);
/** Text: per coin and side — today's altcoin rules, the best 20 by sum, the best per stop pad (robust = both halves > 0). */
export function btcStudyText(r: BtcReport): string {
  const out = [`Нигилист — BTC: свои стоп и выход, расчёт ${r.finishedAt ?? "—"}`];
  for (const g of r.ranges) out.push(`${g.symbol}: ${g.from?.slice(0, 10) ?? "—"} – ${g.to?.slice(0, 10) ?? "—"}, свечей 30m ${g.bars30m}, сигналов (макс. по запасу стопа) ${g.signals}`);
  out.push("Колонки: запас стопа % | выход | ср. стоп % | сделок (откр.) | плюс % | стоп % | ср. % | сумма % | PF | просадка | 1-я пол. ср. | 2-я пол. ср. | ср. часов | ср. % маржи 10x | ср. % маржи 50x | стопов дальше ликвидации 50x");
  const line = (x: BtcRow) => [x.pad, x.label, x.avgRiskPct, `${x.stats.n} (${x.stats.open})`, Math.round(x.stats.winPct), Math.round(x.stats.stopPct),
    sg(x.stats.avg), sg(x.stats.sum, 1), x.stats.pf ?? "—", sg(-x.stats.maxDd, 1), sg(x.stats.half1.avg), sg(x.stats.half2.avg), x.stats.avgHoldH, sg(x.margin10Avg, 1), sg(x.margin50Avg, 1), x.liqStops].join(" | ");
  for (const symbol of BTC_STUDY_SYMBOLS) for (const side of ["short", "long"] as const) {
    const rows = r.rows.filter((x) => x.symbol === symbol && x.side === side && x.stats.n > 0);
    if (!rows.length) continue;
    out.push("", `=== ${symbol} · ${side === "short" ? "шорты" : "лонги"}`, "-- как у альтов сейчас (по запасу стопа):");
    rows.filter((x) => x.exit === "alt_rules").sort((a, b) => a.pad - b.pad).forEach((x) => out.push(line(x)));
    out.push("-- лучшие 20 по сумме:");
    [...rows].sort((a, b) => b.stats.sum - a.stats.sum).slice(0, 20).forEach((x) => out.push(line(x)));
    out.push("-- устойчивые (обе половины в плюсе, от 10 сделок), лучшие 20 по сумме:");
    rows.filter((x) => x.stats.n >= 10 && (x.stats.half1.avg ?? -1) > 0 && (x.stats.half2.avg ?? -1) > 0)
      .sort((a, b) => b.stats.sum - a.stats.sum).slice(0, 20).forEach((x) => out.push(line(x)));
  }
  return out.join("\n");
}
