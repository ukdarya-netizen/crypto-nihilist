import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candle } from "../engine/candles";
import { applyCandles, openTrade, tradeResult } from "../engine/trade";
import { simulate, stats, variants } from "./strategy-sim";

const H = 30 * 60_000;
const byId = (id: string) => variants().find((v) => v.id === id)!;

function walk(seed: number, n: number, start: number): Candle[] {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = p, c = p * (1 + (rnd() - 0.48) * 0.06);
    out.push({ t: start + i * H, o, h: Math.max(o, c) * (1 + rnd() * 0.02), l: Math.min(o, c) * (1 - rnd() * 0.02), c });
    p = c;
  }
  return out;
}

test("'source' variant = Nihilist's own management (engine/trade.ts) on 400 random paths, long and short", () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (const side of ["long", "short"] as const) {
      const cs = walk(seed * (side === "long" ? 1 : 7), 400, 0);
      const entry = cs[0]!.c, stop = side === "long" ? entry * 0.92 : entry * 1.08;
      const t = { id: "x", side, entry, stop, openedAt: H, maxHoldMs: 7 * 86_400_000 };
      const sim = simulate(t, cs, H, byId("source"));
      const { state } = applyCandles(openTrade({ side, entry, stop, tp1: 0, openedAt: H, maxHoldMs: t.maxHoldMs, breakevenAtPct: 5, takeProfit: false }), cs, H);
      assert.equal(sim.closed, state.closed, `seed ${seed} ${side}`);
      if (sim.closed) {
        assert.equal(sim.reason, state.closeReason, `seed ${seed} ${side}`);
        assert.equal(sim.closedAt, state.closedAt);
        assert.equal(sim.pnlPct, tradeResult(state).pnlPct, `seed ${seed} ${side}`);
      }
    }
  }
});

test("take, break-even and partial: exact results", () => {
  const t = { id: "x", side: "long" as const, entry: 100, stop: 90, openedAt: 0, maxHoldMs: 86_400_000 };
  const up = [{ t: 0, o: 100, h: 106, l: 99, c: 105 }, { t: H, o: 105, h: 112, l: 104, c: 111 }, { t: 2 * H, o: 111, h: 111, l: 99, c: 100 }];
  assert.deepEqual([simulate(t, up, H, byId("take8")).reason, simulate(t, up, H, byId("take8")).pnlPct], ["take", 7.9]);
  const be = simulate(t, up, H, byId("be5_take15"));
  assert.equal(be.reason, "breakeven"); assert.equal(be.pnlPct, -0.1);
  const half = simulate(t, up, H, byId("half5_take15"));
  assert.equal(half.reason, "breakeven"); assert.equal(half.pnlPct, 2.4); // 50% × 5% − fees
  // Short: stop above, take below.
  const s = { ...t, side: "short" as const, stop: 110 };
  const down = [{ t: 0, o: 100, h: 101, l: 94, c: 95 }];
  assert.equal(simulate(s, down, H, byId("take5")).pnlPct, 4.9);
  // Stop first inside a candle that touches both.
  const both = [{ t: 0, o: 100, h: 120, l: 89, c: 100 }];
  assert.equal(simulate(t, both, H, byId("take10")).reason, "stop");
});

test("stats: buckets, halves, drawdown", () => {
  const rows = [-10, 5, -2, 20].map((p, i) => ({ tradeId: String(i), openedAt: i * 1000, closedAt: i * 1000 + 10, pnlPct: p, reason: p < 0 ? "stop" : "take", holdH: 24, peakPct: 0 }));
  const s = stats(rows, 1);
  assert.equal(s.n, 4); assert.equal(s.open, 1); assert.equal(s.sum, 13); assert.equal(s.maxDd, 10);
  assert.equal(s.half1.n, 2); assert.equal(s.half2.n, 2); assert.equal(s.pf, 25 / 12 > 0 ? Math.round((25 / 12) * 1000) / 1000 : null);
  assert.deepEqual(s.buckets.slice(0, 2), [["< −10%", 0], ["−10…−5%", 1]]); assert.equal(s.perDay, 3.25);
});

test("R variants: levels are multiples of the trade's own stop distance; 'take8_10' = the rules until 10.11", () => {
  // Long 100 → stop 90 (1R = 10%): price runs to +25% in one step.
  const cs: Candle[] = [{ t: 0, o: 100, h: 100, l: 100, c: 100 }, { t: H, o: 100, h: 125, l: 99, c: 124 }];
  const t = { id: "r", side: "long" as const, entry: 100, stop: 90, openedAt: H, maxHoldMs: 7 * 86_400_000 };
  const take2R = simulate(t, cs, H, byId("take2R"));
  assert.equal(take2R.reason, "take");
  assert.ok(Math.abs(take2R.pnlPct - (20 - 0.1)) < 1e-6);
  const half = simulate(t, cs, H, byId("half1.5R_take3R")); // 50% at 15%, rest needs 30% — still open
  assert.equal(half.closed, false);
  const old = simulate(t, cs, H, byId("take8_10"));
  assert.equal(old.reason, "take");
  assert.ok(Math.abs(old.pnlPct - (10 - 0.1)) < 1e-6);
  const short = simulate({ ...t, side: "short", stop: 110 }, [{ t: 0, o: 100, h: 100, l: 100, c: 100 }, { t: H, o: 100, h: 101, l: 85, c: 86 }], H, byId("take8_10"));
  assert.ok(Math.abs(short.pnlPct - (8 - 0.1)) < 1e-6);
  // Now: 50% at +10%, trailing from +15% (peak 25% → stop at +15% for the rest, still open).
  const now = simulate(t, cs, H, byId("now"));
  assert.equal(now.closed, false);
});
