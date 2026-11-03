import assert from "node:assert/strict";
import { test } from "node:test";
import { SPAN, closedIdx, deltaDivergence, entryFlowMetrics, oiQuadrant, pointFlowMetrics, postEntryMetrics, type FlowSeries, type FlowSignal } from "./flow";
import { mirror, type C } from "./vsa";

const H = 3_600_000;
function bars(tf: string, from: number, n: number, f: (i: number) => Partial<C> = () => ({})): C[] {
  const out: C[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, c = p * (1 + (i % 2 ? 0.002 : -0.0015));
    out.push({ t: from + i * SPAN[tf]!, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 100, ...f(i) });
    p = out[i]!.c;
  }
  return out;
}
const T0 = Date.UTC(2026, 9, 1);
const signalAt = T0 + 200 * H;
const touch = signalAt - 6 * H;
const blockTime = T0 + 120 * H;

function series(side: "long" | "short", over: Partial<FlowSeries> = {}): FlowSeries {
  const raw: Record<string, C[]> = {
    "15m": bars("15m", T0, 1200), "30m": bars("30m", T0, 600),
    "1h": bars("1h", T0, 300), "4h": bars("4h", T0, 80, (i) => (i === 30 ? { v: 500 } : {})), "1d": bars("1d", T0 - 20 * 24 * H, 33),
  };
  const b = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, side === "short" ? mirror(v) : v]));
  const oi = (tf: string, n: number, up: boolean) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * SPAN[tf]!, c: 1000 * (1 + (up ? 1 : -1) * 0.001 * i) }));
  const tk = (tf: string, n: number, buyShare: number) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * SPAN[tf]!, buy: 100 * buyShare, sell: 100 * (1 - buyShare) }));
  return {
    side, bars: b,
    oi: { "15m": oi("15m", 1200, true), "30m": oi("30m", 600, true), "1h": oi("1h", 300, true), "4h": oi("4h", 80, true), "1d": oi("1d", 10, true) },
    fut: { "15m": tk("15m", 1200, 0.6), "30m": tk("30m", 600, 0.6), "1h": tk("1h", 300, 0.6), "4h": tk("4h", 80, 0.6) },
    spot: { "15m": tk("15m", 1200, 0.4), "30m": tk("30m", 600, 0.4), "1h": tk("1h", 300, 0.4), "4h": tk("4h", 80, 0.4) },
    ...over,
  };
}
const sig = (side: "long" | "short"): FlowSignal => ({ symbol: "X-USDT", side, htf: "4h", ltf: "30m", signalAt, firstTouchAt: touch, blockTime });

test("closedIdx: only bars closed by the moment", () => {
  const b = bars("1h", 0, 10);
  assert.equal(closedIdx(b, "1h", 0), -1);
  assert.equal(closedIdx(b, "1h", H), 0);
  assert.equal(closedIdx(b, "1h", 5.5 * H), 4);
});

test("entry metrics: VSA on 30m/1h/4h/1D, block volume, approach, OI on all timeframes, quadrants, delta", () => {
  const m = entryFlowMetrics(sig("long"), series("long"));
  for (const tf of ["30m", "1h", "4h", "1d"]) assert.ok(`vsa${tf}_choch_vol_rel` in m, tf);
  assert.equal(m.ob_vol_rel, 5); // the block candle had 5× the volume
  assert.ok(Number(m.ob_vol_rank) > 90);
  for (const tf of ["30m", "1h", "4h"]) assert.ok(`app${tf}_vol_trend` in m, tf);
  for (const tf of ["15m", "30m", "1h", "4h", "1d"]) assert.ok(Number(m[`oi${tf}_chg1`]) > 0, tf);
  assert.ok(Number(m.oi15m_chg_touch) > 0);
  assert.ok(typeof m.oi_quad_break_15m === "string");
  assert.equal(m.dlt_fut_touch_net, 20);   // 60% buys → +20 for a long
  assert.equal(m.dlt_spot_touch_net, -20); // 40% buys → −20
  assert.equal(m.dlt_spot_minus_fut_touch, -40);
  assert.ok(["divergence", "confirmed", "no_new_extreme"].includes(String(m.dlt_div_fut)));
});

test("shorts are mirrored: buying is against a short", () => {
  const m = entryFlowMetrics(sig("short"), series("short"));
  assert.equal(m.dlt_fut_touch_net, -20);
  assert.equal(m.dlt_spot_touch_net, 20);
});

test("OI quadrant names who moved the price", () => {
  assert.equal(oiQuadrant(1, 2), "with_new_positions");
  assert.equal(oiQuadrant(1, -2), "on_closing_positions");
  assert.equal(oiQuadrant(-1, 2), "against_new_positions");
  assert.equal(oiQuadrant(-1, -2), "against_on_closing");
  assert.equal(oiQuadrant(null, 2), null);
});

test("delta divergence: new low after the touch with rising delta = divergence", () => {
  const p = bars("30m", T0, 20, (i) => (i === 15 ? { l: 50 } : {}));
  const t = T0 + 10 * SPAN["30m"]!, at = T0 + 18 * SPAN["30m"]!;
  const rising = Array.from({ length: 80 }, (_, i) => ({ t: T0 + i * SPAN["15m"]!, buy: 70, sell: 30 }));
  const falling = rising.map((r) => ({ ...r, buy: 30, sell: 70 }));
  assert.equal(deltaDivergence(p, rising, "15m", t, at, 1), "divergence");
  assert.equal(deltaDivergence(p, falling, "15m", t, at, 1), "confirmed");
  assert.equal(deltaDivergence(bars("30m", T0, 20), rising, "15m", t, at, 1), "no_new_extreme");
});

test("after the entry: VSA snapshot, OI since entry, volume against the trade; +1h/+2h/+4h marks", () => {
  const s = series("long", {});
  // Heavy down bars right after the entry.
  const b30 = s.bars["30m"]!;
  const k = closedIdx(b30, "30m", signalAt);
  for (const i of [k + 1, k + 2]) b30[i] = { ...b30[i]!, o: 101, c: 99, v: 400 };
  const p = pointFlowMetrics(sig("long"), s, signalAt + 2 * H);
  assert.ok(Number(p.post_against_share) > 0.6, String(p.post_against_share));
  assert.equal(p.post_max_against_vol_rel, 4);
  assert.ok(Number(p.oi_since_entry) > 0);
  assert.equal(p.dlt_fut_since_entry, 20);
  assert.ok("v30m_last_vol_rel" in p && "oi1d_chg1" in p);
  const post = postEntryMetrics(sig("long"), s, signalAt + 5 * H);
  assert.ok("post1h_vol_rel" in post && "post4h_against_share" in post && "post2h_oi_since_entry" in post);
});
