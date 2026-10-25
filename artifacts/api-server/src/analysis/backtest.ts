/**
 * Read-only history check of the Crypto Nihilist setups (no DB writes).
 *
 *   node --import tsx src/analysis/backtest.ts                 # JCT-USDT, 60 days
 *   node --import tsx src/analysis/backtest.ts --symbols JCT-USDT,BTC-USDT --days 90
 *   node --import tsx src/analysis/backtest.ts --universe 150 --days 60
 *   node --import tsx src/analysis/backtest.ts --universe 0 --days 60    # every BingX pair
 *
 * Two variants are printed from the same candles: the live rule (one trade
 * per order block) and, for comparison, a block allowed to give another
 * signal after a fresh touch. Stop the API while running a large backtest:
 * both share one CoinGlass key.
 *
 * Candles: BingX via CoinGlass (NIHILIST_COINGLASS_API_KEY). Trades are
 * simulated exactly as live: entry = close of the CHoCH bar, 50% at TP1 then
 * stop to entry, 50% at TP2, stop checked before targets inside a bar,
 * timeout by the block timeframe, fees 0.05% per side, one open trade per
 * symbol and setup.
 */
import { INTERVAL_MS, type Candle, type Interval } from "../engine/candles";
import { COMBOS, MAX_HOLD_MS } from "../engine/config";
import { evaluateSetups, type SetupOptions, type SetupSignal } from "../engine/setups";
import { applyCandles, openTrade, tradeResult } from "../engine/trade";
import { getCandleHistory, getUniverse } from "../market/coinglass";

type Row = SetupSignal & { symbol: string; closeReason: string | null; pnlPct: number; r: number; open: boolean };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAYS = Number(arg("days") ?? 60);
const WARMUP = 400;

async function history(symbol: string): Promise<Record<Interval, Candle[]> | null> {
  const want: Record<Interval, number> = {
    "30m": DAYS * 48 + WARMUP, "1h": DAYS * 24 + WARMUP, "4h": 700, "1d": 500,
  };
  const out = {} as Record<Interval, Candle[]>;
  for (const interval of Object.keys(want) as Interval[]) {
    const candles = await getCandleHistory(symbol, interval, want[interval]);
    if (!candles || candles.length < 50) return null;
    const span = INTERVAL_MS[interval];
    out[interval] = candles.filter((c) => c.t + span <= Date.now());
  }
  return out;
}

function simulate(symbol: string, data: Record<Interval, Candle[]>, options: Partial<SetupOptions> = {}): Row[] {
  const rows: Row[] = [];
  const from = Date.now() - DAYS * 86_400_000;
  for (const combo of COMBOS) {
    const { signals } = evaluateSetups({
      htf: combo.htf, ltf: combo.ltf, htfCandles: data[combo.htf], ltfCandles: data[combo.ltf], options,
    });
    let busyUntil = 0;
    for (const s of signals.sort((a, b) => a.signalAt - b.signalAt)) {
      if (s.signalAt < from || s.signalAt < busyUntil) continue;
      const trade = applyCandles(
        openTrade({ side: s.side, entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2, openedAt: s.signalAt, maxHoldMs: MAX_HOLD_MS[s.htf] }),
        data["30m"], INTERVAL_MS["30m"],
      );
      const last = data["30m"][data["30m"].length - 1];
      const result = tradeResult(trade, last?.c);
      busyUntil = trade.closed ? (trade.closedAt as number) : Infinity;
      rows.push({ ...s, symbol, closeReason: trade.closeReason, pnlPct: result.pnlPct, r: result.r, open: !trade.closed });
    }
  }
  return rows;
}

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function summary(title: string, rows: Row[]): void {
  console.log(`\n== ${title}`);
  const bySetup = new Map<string, Row[]>();
  for (const r of rows) bySetup.set(r.setup, [...(bySetup.get(r.setup) ?? []), r]);
  console.log("\nsetup            | n    | win%  | tp1%  | stop% | avgR  | sumR    | avg pnl%");
  for (const [setup, list] of [...bySetup.entries()].sort()) {
    const closed = list.filter((r) => !r.open);
    const n = closed.length;
    const wins = closed.filter((r) => r.pnlPct > 0).length;
    const tp1 = list.filter((r) => r.closeReason === "tp2" || r.closeReason === "breakeven").length;
    const stops = closed.filter((r) => r.closeReason === "stop").length;
    const sumR = closed.reduce((a, r) => a + r.r, 0);
    const pnl = closed.reduce((a, r) => a + r.pnlPct, 0);
    console.log(
      `${setup.padEnd(16)} | ${String(n).padEnd(4)} | ${fmt((wins / n) * 100, 1).padEnd(5)} | ${fmt((tp1 / n) * 100, 1).padEnd(5)} | ${fmt((stops / n) * 100, 1).padEnd(5)} | ${fmt(sumR / n).padEnd(5)} | ${fmt(sumR).padEnd(7)} | ${fmt(pnl / n)}` +
      (list.length > n ? `  (+${list.length - n} open)` : ""),
    );
  }
}

async function main(): Promise<void> {
  let symbols = (arg("symbols") ?? "JCT-USDT").split(",").map((s) => s.trim()).filter(Boolean);
  const universeCount = arg("universe");
  if (universeCount) {
    const universe = await getUniverse();
    if (!universe) throw new Error("CoinGlass universe request failed");
    const n = Number(universeCount);
    symbols = (n > 0 ? universe.slice(0, n) : universe).map((u) => u.instrumentId);
  }
  console.log(`Crypto Nihilist backtest: ${symbols.length} symbols, ${DAYS} days (BingX via CoinGlass)`);
  const all: Row[] = [];
  const allReuse: Row[] = [];
  let skipped = 0;
  let done = 0;
  for (const symbol of symbols) {
    const data = await history(symbol);
    done += 1;
    if (done % 50 === 0) console.log(`… ${done}/${symbols.length}`);
    if (!data) { skipped += 1; if (symbols.length <= 20) console.log(`${symbol}: no data — skipped`); continue; }
    const rows = simulate(symbol, data);
    all.push(...rows);
    allReuse.push(...simulate(symbol, data, { reuseBlocks: true }));
    if (symbols.length <= 5) {
      const live = new Set(rows.map((x) => `${x.setup}:${x.signalAt}`));
      const extra = allReuse.filter((x) => x.symbol === symbol && !live.has(`${x.setup}:${x.signalAt}`));
      console.log(`\n${symbol}: ${rows.length} trades (+${extra.length} more if a block may trade again, marked *)`);
      for (const r of [...rows, ...extra.map((x) => ({ ...x, setup: `${x.setup}*` }))]) {
        console.log(
          `  ${date(r.signalAt)} ${r.setup.padEnd(13)} ${r.block.scope.padEnd(8)} OB ${fmt(r.block.bottom, 6)}–${fmt(r.block.top, 6)}` +
          ` entry ${fmt(r.entry, 6)} stop ${fmt(r.stop, 6)} (${fmt(r.riskPct)}%) tp1 ${fmt(r.tp1, 6)} tp2 ${fmt(r.tp2, 6)}` +
          ` → ${r.open ? "open" : r.closeReason} ${fmt(r.pnlPct)}% ${fmt(r.r)}R`,
        );
      }
    }
  }
  summary("live rule: one trade per order block", all);
  summary("comparison: a block may trade again after a fresh touch", allReuse);
  console.log(`\nsymbols with data: ${symbols.length - skipped}, skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
