import assert from "node:assert/strict";
import { test } from "node:test";
import { supertrend, waves } from "./candidate-study";

test("waves: swings of at least 2%", () => {
  assert.equal(waves([100, 101, 102, 103]), 0);
  assert.equal(waves([100, 104, 101, 105, 102, 106]), 4);
});
test("supertrend follows a clear trend", () => {
  const up = Array.from({ length: 60 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const down = up.map((c, i) => ({ t: i, o: 200 - i, h: 201 - i, l: 199 - i, c: 199.5 - i }));
  assert.equal(supertrend(up), 1);
  assert.equal(supertrend(down), -1);
});

test("structure series (owner 2026-11-15): bar by bar, no later bar used; an up-trend reads as up", async () => {
  const { structureSeries } = await import("./candidate-study");
  const cs = Array.from({ length: 400 }, (_, i) => {
    const base = 100 + i * 0.2 + 3 * Math.sin(i / 6);
    return { t: i * 3_600_000, o: base, h: base + 1, l: base - 1, c: base + 0.3, v: 1 };
  });
  const full = structureSeries(cs as never);
  const part = structureSeries(cs.slice(0, 250) as never);
  assert.deepEqual(part, full.slice(0, 250));
  assert.equal(full[399]!.it, 1);
});

test("Lucy's VSA (owner 2026-11-15): Welkin letters as her indicator; a bright bar at a 20-bar low with a confirming bar = BUY", async () => {
  const { vsaSeries } = await import("./candidate-study");
  const H4 = 4 * 3_600_000;
  const cs = Array.from({ length: 160 }, (_, i) => ({ t: i * H4, o: 100, h: 101, l: 99, c: 100.2, v: 1 }));
  cs[150] = { t: 150 * H4, o: 99, h: 100, l: 90, c: 99.5, v: 1 };     // lowest low of 20, closes in the upper half
  cs[151] = { t: 151 * H4, o: 99.5, h: 100, l: 95, c: 99.8, v: 1 };   // above the middle (95), no lower low
  const fut = new Map(cs.map((c, i) => [c.t, i === 150 ? 1000 : 100 + (i % 3)] as [number, number]));
  const rows = vsaSeries(cs as never, fut, null);
  assert.equal(rows[150]!.letter, 5);   // W
  assert.equal(rows[151]!.buy, true);
  assert.equal(rows[140]!.bright, false);
});

test("VSA 1h (owner 2026-11-15): a bright rising 1h bar right before a short counts as the buyer against it", async () => {
  const { vsaSeries, vsa1hMeasures } = await import("./candidate-study");
  const H = 3_600_000;
  const cs = Array.from({ length: 200 }, (_, i) => ({ t: i * H, o: 100, h: 101, l: 99, c: i === 198 ? 100.8 : 100, v: 1 }));
  const fut = new Map(cs.map((c, i) => [c.t, i === 198 ? 1000 : 100 + (i % 3)] as [number, number]));
  const rows = vsaSeries(cs as never, fut, null);
  const m = vsa1hMeasures({ side: "short", signalAt: 199 * H } as never, cs as never, rows);
  assert.equal(m.vsa1h_bright_against_1, 1);
  assert.equal(m.vsa1h_bright_with_1, 0);
});

test("indicators and VPVR (owner 2026-11-15): a steady rise reads up for a long, the POC sits where the volume was", async () => {
  const { indicators, vpvr } = await import("./candidate-study");
  const H = 3_600_000;
  const cs = Array.from({ length: 200 }, (_, i) => { const b = 100 + i * 0.5; return { t: i * H, o: b, h: b + 0.6, l: b - 0.4, c: b + 0.4, v: 0 }; });
  const m = indicators(cs as never, 1, "1h", cs[199]!.c);
  assert.ok((m.adx_1h ?? 0) > 25); assert.ok((m.di_1h ?? 0) > 0); assert.equal(m.psar_1h, 1); assert.equal(m.ichi_cloud_1h, 1);
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: i * H, o: 10, h: i < 20 ? 10.2 : 12.2, l: i < 20 ? 9.8 : 11.8, c: 10, v: 0 }));
  const vol = new Map(flat.map((c, i) => [c.t, i < 20 ? 1000 : 10] as [number, number]));
  const p = vpvr(flat as never, vol, 30 * H, 24, 12, "24h");
  assert.ok((p.vp_poc_24h ?? 0) > 15);   // entry 12 is ~20% above the POC near 10
});

test("SMT with BTC (owner 2026-11-15): the coin swept its low and BTC did not — bullish divergence for a long", async () => {
  const { smtMeasures } = await import("./candidate-study");
  const H = 3_600_000;
  const mk = (low: number) => Array.from({ length: 30 }, (_, i) => ({ t: i * H, o: 10, h: 10.5, l: i === 28 ? low : 9.5, c: 10, v: 0 }));
  const m = smtMeasures({ side: "long", signalAt: 30 * H } as never, { "1h": mk(9), "4h": [] } as never, { "1h": mk(9.6), "4h": [] } as never);
  assert.equal(m.smt_1h, 1);   // the coin swept its low, BTC did not
});
