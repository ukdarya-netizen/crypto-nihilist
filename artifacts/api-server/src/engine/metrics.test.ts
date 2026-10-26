import assert from "node:assert/strict";
import test from "node:test";
import { closedAsOf, coversAsOf, ema, rsi, signalSnapshot, type BookLike, type SignalLike } from "./metrics";
import { candlesFromCloses } from "./testCandles.test-helper";
import { analyzeMetrics, type AnalysisRow } from "../stats/metricAnalysis";

const H = 3_600_000;
const start = Date.UTC(2026, 0, 1);
const END = start + 2000 * H;
/** n rising bars ending at END (all timeframes aligned in time). */
const rising = (n: number, span: number, from = 100, step = 0.1) =>
  candlesFromCloses(Array.from({ length: n }, (_, i) => from + i * step), END - n * span, span);
const bookOf = (): BookLike => ({
  "30m": rising(800, H / 2), "1h": rising(700, H), "4h": rising(400, 4 * H), "1d": rising(250, 24 * H),
});

test("indicators: RSI of a steady rise is 100, EMA lags the price", () => {
  const c = rising(100, H);
  assert.equal(rsi(c), 100);
  const e = ema(c, 20)!;
  assert.ok(e < c[c.length - 1].c && e > c[0].c);
});

test("only bars closed by the signal time are used (no look-ahead)", () => {
  const c = rising(10, H);
  const asOf = c[5].t + H; // bar 5 just closed
  void start;
  assert.equal(closedAsOf(c, "1h", asOf).length, 6);
  assert.equal(closedAsOf(c, "1h", asOf - 1).length, 5);
});

test("snapshot: geometry, trend alignment, coin and BTC context", () => {
  const coin = bookOf();
  const asOf = coin["30m"][780].t + H / 2;
  const sig: SignalLike = {
    symbol: "JCT-USDT", side: "long", htf: "4h", ltf: "30m", entry: 160, stop: 150, tp1: 180, riskPct: 6.25, rr1: 2,
    blockTop: 158, blockBottom: 154, blockScope: "internal", blockCreatedAt: asOf - 10 * H,
    firstTouchAt: asOf - 3 * H, lastTouchAt: asOf - H, htfSwingTrend: 1, htfInternalTrend: -1, ltfAtr: 1.6,
    targetsSource: "structure", signalAt: asOf,
  };
  assert.ok(coversAsOf(coin, asOf));
  const m = signalSnapshot(sig, coin, bookOf());
  assert.equal(m.tp1_pct, 12.5);
  assert.equal(m.block_age_h, 10);
  assert.equal(m.since_last_touch_h, 1);
  assert.equal(m.htf_swing_aligned, true);
  assert.equal(m.htf_internal_aligned, false);
  assert.equal(m.trend_4h, "up");
  assert.equal(m.trend_4h_aligned, true);
  assert.equal(m.btc_trend_4h_aligned, true);
  assert.equal(typeof m.rsi_1h, "number");
  assert.equal(typeof m.btc_chg24h, "number");
  assert.ok(Number(m.chg24h) > 0);
});

test("metric analysis: quartiles and labels with CAB win rate and avg R", () => {
  const rows: AnalysisRow[] = Array.from({ length: 16 }, (_, i) => ({
    id: i, symbol: "X-USDT", setup: "4h_30m_long", side: "long", status: "closed", live: true,
    close_reason: i < 8 ? "stop" : "trailing", pnl_pct: i < 8 ? -5 : 10, r_multiple: i < 8 ? -1 : 2,
    peak_pct: 0, mfe_pct: 0, opened_at: "2026-01-01", closed_at: "2026-01-02",
    metrics: { rsi_1h: i, aligned: i >= 8 },
  }));
  const out = analyzeMetrics(rows);
  const rsiA = out.find((m) => m.key === "rsi_1h")!;
  assert.equal(rsiA.kind, "number");
  assert.equal(rsiA.buckets.length, 4);
  assert.equal(rsiA.buckets[0].winRate, 0);
  assert.equal(rsiA.buckets[3].avgR, 2);
  assert.equal(rsiA.spreadR, 3);
  const flag = out.find((m) => m.key === "aligned")!;
  assert.deepEqual(flag.buckets.map((b) => [b.label, b.winRate]).sort(), [["false", 0], ["true", 100]]);
});

import { trajectoryPoints } from "./trajectory";
test("trajectory: touch and every 30m before the signal, 30m for a day after, then every 4h", () => {
  const sig = Date.UTC(2026, 9, 26, 12);
  const pts = trajectoryPoints(sig, sig - 100 * 60_000, sig + 3 * 86_400_000);
  const labels = pts.map((p) => p.label);
  assert.deepEqual(labels.slice(0, 4), ["touch", "-90m", "-60m", "-30m"]);
  assert.ok(labels.includes("+15m") && labels.includes("+30m") && labels.includes("+1440m"));
  assert.ok(labels.includes("+28h") && labels.includes("+72h"));
  assert.ok(!labels.includes("+76h"), "nothing after the close");
  assert.equal(new Set(labels).size, labels.length);
});
