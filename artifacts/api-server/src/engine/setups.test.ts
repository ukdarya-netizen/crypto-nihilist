import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "./candles";
import { evaluateSetups } from "./setups";
import { candlesFromCloses, path } from "./testCandles.test-helper";

const M30 = 30 * 60_000;

function aggregate(candles: Candle[], per: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + per <= candles.length; i += per) {
    const part = candles.slice(i, i + per);
    out.push({
      t: part[0].t, o: part[0].o, c: part[part.length - 1].c,
      h: Math.max(...part.map((c) => c.h)), l: Math.min(...part.map((c) => c.l)),
    });
  }
  return out;
}

/** 4h: bearish leg, then bullish CHoCH leaving a bullish OB near 84; 30m: return into it and flip up. */
function scenario(bottom: number) {
  const htfShape = path([[90, 80], [100, 80], [84, 128], [104, 160]], 100);
  const ltfReturn = path([[96, 8], [98, 6], [89, 12], [90.5, 6], [bottom, 12], [97, 20], [99, 10]], 104).slice(1);
  const closes = [...htfShape, ...ltfReturn];
  const start = Date.UTC(2026, 0, 1);
  const ltf = candlesFromCloses(closes, start, M30);
  const usable = ltf.slice(0, Math.floor(ltf.length / 8) * 8);
  return { ltf: usable, htf: aggregate(usable, 8) };
}

test("long: 30m CHoCH after the price returns into a 4h bullish order block", () => {
  const { ltf, htf } = scenario(84.8);
  const { signals } = evaluateSetups({ htf: "4h", ltf: "30m", htfCandles: htf, ltfCandles: ltf, sides: ["long"] });
  assert.equal(signals.length, 1, JSON.stringify(signals));
  const s = signals[0];
  assert.equal(s.setup, "4h_30m_long");
  assert.ok(s.entry > 90.5 && s.entry < 93, `entry ${s.entry}`);
  assert.ok(s.stop < 84.8 * 0.999, `stop ${s.stop}`);
  assert.ok(s.block.bottom < 84.8 && s.block.top >= 84.8 * 0.999);
  assert.equal(s.targetsSource, "structure");
  assert.ok(s.tp1 > 103 && s.tp1 < 105, `tp1 ${s.tp1}`);
  assert.ok(s.rr1 >= 1);
});

test("no signal when the return trades through the block bottom", () => {
  const { ltf, htf } = scenario(82);
  const { signals } = evaluateSetups({ htf: "4h", ltf: "30m", htfCandles: htf, ltfCandles: ltf, sides: ["long"] });
  assert.equal(signals.length, 0);
});

test("no lookahead: nothing before the order block's 4h bar has closed", () => {
  const { ltf, htf } = scenario(84.8);
  const full = evaluateSetups({ htf: "4h", ltf: "30m", htfCandles: htf, ltfCandles: ltf, sides: ["long"] });
  const signalAt = full.signals[0].signalAt;
  // Same LTF bars, but HTF bars only up to the signal: identical result.
  const partialHtf = htf.filter((c) => c.t + 4 * 60 * 60_000 <= signalAt);
  const partial = evaluateSetups({ htf: "4h", ltf: "30m", htfCandles: partialHtf, ltfCandles: ltf.filter((c) => c.t + M30 <= signalAt), sides: ["long"] });
  assert.equal(partial.signals.length, 1);
  assert.equal(partial.signals[0].entry, full.signals[0].entry);
  assert.equal(partial.signals[0].tp1, full.signals[0].tp1);
});

test("short is the mirror image", () => {
  const { ltf, htf } = scenario(84.8);
  const mirror = (c: Candle): Candle => ({ t: c.t, o: 200 - c.o, c: 200 - c.c, h: 200 - c.l, l: 200 - c.h });
  const { signals } = evaluateSetups({ htf: "4h", ltf: "30m", htfCandles: htf.map(mirror), ltfCandles: ltf.map(mirror), sides: ["short"] });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, "short");
  assert.ok(signals[0].stop > signals[0].entry && signals[0].tp1 < signals[0].entry);
});

test("stop sits 3% beyond the TA stop (owner rule); rr and risk follow it", () => {
  const { ltf, htf } = scenario(84.8);
  const base = { htf: "4h" as const, ltf: "30m" as const, htfCandles: htf, ltfCandles: ltf, sides: ["long" as const] };
  const ta = evaluateSetups({ ...base, options: { stopExtraPct: 0, minRr: 0 } }).signals[0];
  const live = evaluateSetups({ ...base, options: { minRr: 0 } }).signals[0];
  assert.ok(ta && live);
  assert.ok(Math.abs(live.stop - ta.stop * 0.97) < 1e-9, `${live.stop} vs ${ta.stop}`);
  assert.ok(live.riskPct > ta.riskPct && live.rr1 < ta.rr1);
});
