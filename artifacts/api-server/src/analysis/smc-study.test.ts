import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../engine/candles";
import { ENTRIES, EXITS, currentMgmt, equalLevel, exitMgmt, fillLimit, lastFvg, runTrade, smcStudyText, studySymbol, type StudyReport } from "./smc-study";

const H = 1_800_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: i * H, o, h, l, c });

test("variants: 10 entries × 6 exits; today's management per side", () => {
  assert.equal(ENTRIES.length, 10);
  assert.equal(EXITS.length, 6);
  assert.deepEqual(currentMgmt("short").take, 8);
  assert.deepEqual(currentMgmt("long").trail, { act: 15, gap: 10 });
});

test("last FVG of the leg, long and short", () => {
  const up = [bar(0, 1, 1.01, 0.99, 1), bar(1, 1, 1.05, 1, 1.04), bar(2, 1.04, 1.1, 1.03, 1.09)];
  assert.equal(lastFvg(up, 0, 2, "long"), 1.03); // bar0 high 1.01 < bar2 low 1.03
  const down = [bar(0, 1, 1.01, 0.99, 1), bar(1, 1, 1, 0.95, 0.96), bar(2, 0.96, 0.97, 0.9, 0.91)];
  assert.equal(lastFvg(down, 0, 2, "short"), 0.97);
  assert.equal(lastFvg(up, 0, 2, "short"), null);
});

test("equal highs: two levels within 0.15% beyond the entry; nearest pair", () => {
  assert.equal(equalLevel([1.1, 1.2, 1.1012], 1, "long"), 1.1012);
  assert.equal(equalLevel([1.1, 1.2], 1, "long"), null);
  assert.equal(equalLevel([0.9, 0.8994], 1, "short"), 0.8994);
});

test("limit fill: better price within the wait only; at the zone already = enter now", () => {
  const sig = { side: "long" as const, entry: 1, signalAt: 10 * H };
  const m30 = [bar(10, 1, 1.02, 0.99, 1.01), bar(11, 1.01, 1.02, 0.97, 0.98), bar(12, 0.98, 1, 0.95, 0.99)];
  assert.deepEqual(fillLimit(sig, 0.97, 4 * H, m30), { filled: true, at: 11 * H, price: 0.97, barsWaited: 2 });
  assert.equal(fillLimit(sig, 0.9, 4 * H, m30).filled, false);
  assert.equal(fillLimit(sig, 0.97, 1 * H, m30).filled, false); // only the first bar waited
  assert.deepEqual(fillLimit(sig, 1.05, 4 * H, m30), { filled: true, at: 10 * H, price: 1, barsWaited: 0 });
  assert.equal(fillLimit(sig, null, 4 * H, m30).filled, false);
});

test("a limit filled in a candle that also hits the stop is a stop", () => {
  const m30 = [bar(11, 1, 1, 0.9, 0.92)];
  const r = runTrade("long", { filled: true, at: 11 * H, price: 0.97, barsWaited: 1 }, 0.92, 7 * 86_400_000, m30, currentMgmt("long"));
  assert.equal(r.reason, "stop");
  assert.ok(r.pnlPct < -5);
});

test("exit targets: liquidity as take %; missing target = n/a; half needs the HTF level beyond the LTF one", () => {
  const t = { ltf: 1.06, htf: 1.15, eqhl: null };
  assert.equal(Math.round(exitMgmt("ltf", "long", 1, t)!.take! * 100) / 100, 6);
  assert.equal(exitMgmt("eqhl", "long", 1, t), null);
  const half = exitMgmt("half_ltf_htf", "long", 1, t)!;
  assert.equal(half.partial!.share, 0.5);
  assert.equal(Math.round(half.take! * 100) / 100, 15);
  assert.equal(exitMgmt("half_ltf_htf", "long", 1, { ltf: 1.06, htf: 1.03, eqhl: null }), null);
  assert.equal(exitMgmt("ltf", "short", 1, { ltf: 1.02, htf: null, eqhl: null }), null); // above a short's entry
});

test("a coin runs end to end without signals or errors; text report renders", () => {
  const m30: Candle[] = []; let p = 1;
  for (let i = 0; i < 3400; i++) { const n = p * (1 + Math.sin(i / 7) * 0.004); m30.push(bar(i, p, Math.max(p, n) * 1.002, Math.min(p, n) * 0.998, n)); p = n; }
  const agg = (k: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i + k <= m30.length; i += k) {
      const s = m30.slice(i, i + k);
      out.push({ t: s[0]!.t, o: s[0]!.o, h: Math.max(...s.map((c) => c.h)), l: Math.min(...s.map((c) => c.l)), c: s[k - 1]!.c });
    }
    return out;
  };
  const data = { "30m": m30, "1h": agg(2), "4h": agg(8), "1d": agg(48) };
  const report: StudyReport = { status: "running", startedAt: "", finishedAt: null, error: null, progress: { done: 0, total: 1 }, rows: [], liveMatched: 0, liveTotal: 0 };
  const csv: string[] = [];
  studySymbol("TEST-USDT", data, new Set(), {}, csv, report);
  assert.ok(csv.every((l) => l.split(",").length === 10 + ENTRIES.length * (1 + EXITS.length)));
  assert.match(smcStudyText({ ...report, status: "done" }), /SMC: уточнённый вход/);
});

test("a real SMC short (mirrored test scenario): geometry, fills and every exit run; live signal studied by name", async () => {
  const { candlesFromCloses, path } = await import("../engine/testCandles.test-helper");
  const { geometry } = await import("./smc-study");
  const { allSignals } = await import("./strategy-report");
  const M30 = 30 * 60_000;
  const agg = (cs: Candle[], k: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i + k <= cs.length; i += k) {
      const s = cs.slice(i, i + k);
      out.push({ t: s[0]!.t, o: s[0]!.o, h: Math.max(...s.map((c) => c.h)), l: Math.min(...s.map((c) => c.l)), c: s[k - 1]!.c });
    }
    return out;
  };
  const closes = [...path([[90, 80], [100, 80], [84, 128], [104, 160]], 100), ...path([[96, 8], [98, 6], [89, 12], [90.5, 6], [84.8, 12], [97, 20], [99, 10]], 104).slice(1), ...path([[99, 400]], 99).slice(1)];
  // Mirrored into a short (shorts have no entry filter).
  const m30 = candlesFromCloses(closes, Date.UTC(2026, 0, 1), M30).map((c) => ({ t: c.t, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c }));
  const usable = m30.slice(0, Math.floor(m30.length / 48) * 48);
  const data = { "30m": usable, "1h": agg(usable, 2), "4h": agg(usable, 8), "1d": agg(usable, 48) };
  const now = usable[usable.length - 1]!.t + M30;
  const sigs = allSignals(data, now).filter((s) => s.setup === "4h_30m_short");
  assert.ok(sigs.length >= 1, "scenario gives a 4h/30m short");
  const s = sigs[0]!;
  const { zones, targets } = geometry(s, data["30m"], (await import("./smc-study")).__walkForTest(data["30m"]));
  assert.ok(zones.eq !== null && zones.eq > s.entry, `equilibrium above a short's entry: ${zones.eq} vs ${s.entry}`);
  assert.ok(targets.htf === null || targets.htf < s.entry);
  const report: StudyReport = { status: "running", startedAt: "", finishedAt: null, error: null, progress: { done: 0, total: 1 }, rows: [], liveMatched: 0, liveTotal: 1 };
  const csv: string[] = []; const acc = {};
  studySymbol("TEST-USDT", data, new Set([`TEST-USDT|${s.setup}|${s.barTime}`]), acc, csv, report, now);
  assert.equal(report.liveMatched >= 1, true);
  assert.ok(csv.length >= 1);
  assert.ok(Object.keys(acc).some((k) => k.startsWith("live|short|cur|cur")));
  assert.ok(csv[0]!.split(",").length === 10 + ENTRIES.length * (1 + EXITS.length));
});
