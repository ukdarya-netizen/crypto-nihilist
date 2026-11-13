import test from "node:test";
import assert from "node:assert/strict";
import { buildBtcView, dailyContext, parseDominance, btcDir, domDir } from "./btc";

const D = 86_400_000;
const day0 = Date.parse("2026-11-01T00:00:00Z");

test("BTC.D history: seconds or ms, sorted, nonsense dropped; daily change only between adjacent days", () => {
  const pts = parseDominance([
    { timestamp: (day0 + D) / 1000, bitcoin_dominance: "58.5", price: "101000" },
    { timestamp: day0, bitcoin_dominance: 58.0, price: 100000 },
    { timestamp: day0 + 2 * D, bitcoin_dominance: 0 },
  ]);
  assert.deepEqual(pts.map((p) => p.dominance), [58, 58.5]);
  const ctx = dailyContext(pts);
  assert.deepEqual(ctx.get("2026-11-02"), { day: "2026-11-02", btcClose: 101000, btcChgPct: 1, dominance: 58.5, domChgPp: 0.5 });
  assert.equal(btcDir(1.5), "up"); assert.equal(btcDir(-0.5), "flat"); assert.equal(domDir(-0.3), "down");
});

test("BTC view: trades by BTC 24h at entry and by the day's BTC.D + BTC scenario, longs and shorts apart", () => {
  const points = parseDominance([
    { timestamp: day0, bitcoin_dominance: 58, price: 100000 },
    { timestamp: day0 + D, bitcoin_dominance: 58.5, price: 97000 },
  ]);
  const row = (id: number, side: string, pnl: number, reason: string, btc: number | null): any => ({
    id, symbol: "X-USDT", setup: `ob_${side}`, side, status: "closed", live: true, close_reason: reason, pnl_pct: pnl, r_multiple: 0,
    peak_pct: 0, mfe_pct: 0, opened_at: new Date(day0 + 2 * D + 3600_000), closed_at: new Date(day0 + 2 * D + 7200_000), btc_chg24h: btc,
  });
  const v = buildBtcView({ rows: [row(1, "short", 8, "take", -3.5), row(2, "long", -5, "stop", -3.2), row(3, "long", 2, "trailing", null)],
    points, now: day0 + 2 * D + 10_000_000, btcPrice: 96500, btcChg24h: -0.5 });
  const lt3 = v.byBtc24h.find((b) => b.id === "lt-3")!;
  assert.equal(lt3.short.closed, 1); assert.equal(lt3.short.netPnlPct, 8);
  assert.equal(lt3.long.closed, 1); assert.equal(lt3.long.winRate, 0);
  const dump = v.scenarios.find((s) => s.dom === "up" && s.btc === "down")!;
  assert.equal(dump.short.closed + dump.long.closed, 3, "entry day context = 2026-11-02: BTC −3%, BTC.D +0.5");
  assert.equal(v.coverage.withBtc24h, 2);
  assert.equal(v.now.dominance, 58.5); assert.equal(v.now.domChg1dPp, 0.5);
  const today = v.daily.at(-1)!;
  assert.equal(today.opened, 3); assert.equal(today.stops, 1); assert.equal(today.closedPnl, 5);
});
