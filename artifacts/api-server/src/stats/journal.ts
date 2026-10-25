/**
 * Statistics in the Crypto Alt Bullet layout. Cohort = signals OPENED in the
 * period (CAB "detected" basis). Statuses of closed trades:
 *   PROFIT    — closed by trailing, or by time in plus;
 *   BE STOP   — closed at the entry stop (after TP1 or a break-even move);
 *               split by the peak it reached first: +5…<8%, +8…<10%, ≥+10%
 *               (and <+5% when TP1 was closer than +5%);
 *   STOP LOSS — the structural stop;
 *   EXPIRED   — closed by time at or below entry.
 * Win rate (as CAB) = (PROFIT + BE STOP) / (PROFIT + BE STOP + STOP LOSS).
 * Every % is the price move with the TP1 half and fees included (no leverage).
 */
export type JournalRow = {
  id: number; symbol: string; setup: string; side: string; status: string; live: boolean;
  close_reason: string | null; pnl_pct: number | null; r_multiple: number | null;
  peak_pct: number | null; mfe_pct: number | null; opened_at: Date | string; closed_at: Date | string | null;
};

export type TradeStatus = "profit" | "be_stop" | "stop_loss" | "expired" | "open";

export function tradeStatus(row: JournalRow): TradeStatus {
  if (row.status !== "closed") return "open";
  if (row.close_reason === "stop") return "stop_loss";
  if (row.close_reason === "breakeven") return "be_stop";
  if (row.close_reason === "timeout") return Number(row.pnl_pct) > 0 ? "profit" : "expired";
  return "profit";
}

const peakOf = (row: JournalRow) => Number(row.peak_pct ?? row.mfe_pct ?? 0);

export function beBucket(row: JournalRow): "lt5" | "5" | "8" | "10" {
  const p = peakOf(row);
  return p >= 10 ? "10" : p >= 8 ? "8" : p >= 5 ? "5" : "lt5";
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const avg = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const sum = (xs: number[]) => round(xs.reduce((a, b) => a + b, 0));

function summarize(rows: JournalRow[]) {
  const closed = rows.filter((r) => r.status === "closed");
  const by = (s: TradeStatus) => closed.filter((r) => tradeStatus(r) === s);
  const profit = by("profit");
  const be = by("be_stop");
  const stop = by("stop_loss");
  const expired = by("expired");
  const wins = profit.length + be.length;
  const denom = wins + stop.length;
  const pnl = (xs: JournalRow[]) => xs.map((r) => Number(r.pnl_pct ?? 0));
  const positives = closed.filter((r) => Number(r.pnl_pct) > 0);
  const negatives = closed.filter((r) => Number(r.pnl_pct) < 0);
  const best = closed.reduce<JournalRow | null>((b, r) => (b === null || Number(r.pnl_pct) > Number(b.pnl_pct) ? r : b), null);
  return {
    total: rows.length,
    open: rows.filter((r) => r.status !== "closed").length,
    closed: closed.length,
    profit: profit.length,
    beStop: be.length,
    stopLoss: stop.length,
    expired: expired.length,
    beBuckets: {
      lt5: be.filter((r) => beBucket(r) === "lt5").length,
      after5: be.filter((r) => beBucket(r) === "5").length,
      after8: be.filter((r) => beBucket(r) === "8").length,
      after10: be.filter((r) => beBucket(r) === "10").length,
    },
    winRate: denom ? Math.round((wins / denom) * 100) : null,
    netPnlPct: sum(pnl(closed)),
    netR: sum(closed.map((r) => Number(r.r_multiple ?? 0))),
    pnlByStatus: { profit: sum(pnl(profit)), beStop: sum(pnl(be)), stopLoss: sum(pnl(stop)), expired: sum(pnl(expired)) },
    avgProfit: avg(pnl(positives)),
    avgLoss: avg(pnl(negatives)),
    avgPeak: avg(closed.map(peakOf)),
    reached: {
      p5: closed.filter((r) => peakOf(r) >= 5).length,
      p10: closed.filter((r) => peakOf(r) >= 10).length,
      p15: closed.filter((r) => peakOf(r) >= 15).length,
      p30: closed.filter((r) => peakOf(r) >= 30).length,
    },
    bestTrade: best ? { symbol: best.symbol, setup: best.setup, pnlPct: Number(best.pnl_pct), id: best.id } : null,
  };
}

export type JournalSummary = ReturnType<typeof summarize>;

export function buildJournal(rows: JournalRow[]) {
  const setups = [...new Set(rows.map((r) => r.setup))].sort();
  return {
    summary: summarize(rows),
    bySetup: setups.map((setup) => ({ setup, ...summarize(rows.filter((r) => r.setup === setup)) })),
  };
}
