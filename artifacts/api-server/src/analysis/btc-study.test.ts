import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../engine/candles";
import { buildRows, btcStudyText, exits, studyPad, type BtcReport } from "./btc-study";

test("exit grid: unique ids, today's alt rules first, R targets scale with the risk", () => {
  const xs = exits();
  assert.equal(new Set(xs.map((x) => x.id)).size, xs.length);
  assert.equal(xs[0]!.id, "alt_rules");
  const r2 = xs.find((x) => x.id === "r2_be1r")!.mgmt(1.2, "long");
  assert.equal(r2.take, 2.4);
  assert.equal(r2.be, 1.2);
  assert.ok(!xs.some((x) => /^be3_take(1|1\.5|2|3)$/.test(x.id)), "no break-even at or beyond the take");
});

test("BTC study on a scenario coin: every pad and exit runs, text renders", async () => {
  const { candlesFromCloses, path } = await import("../engine/testCandles.test-helper");
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
  const m30 = candlesFromCloses(closes, Date.UTC(2026, 0, 1), M30).map((c) => ({ t: c.t, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c }));
  const u = m30.slice(0, Math.floor(m30.length / 48) * 48);
  const data = { "30m": u, "1h": agg(u, 2), "4h": agg(u, 8), "1d": agg(u, 48) };
  const acc = new Map(); const csv: string[] = [];
  const n = studyPad("BTC-USDT", data, 0.5, 0, acc, csv);
  assert.ok(n >= 1, "the scenario gives signals");
  assert.ok(csv.length >= exits().length, "one closed trade per exit at least");
  const rows = buildRows(acc);
  assert.ok(rows.some((r) => r.exit === "alt_rules" && r.side === "short"));
  const report: BtcReport = { status: "done", startedAt: "", finishedAt: "x", error: null, progress: { done: 1, total: 1, stage: "" }, ranges: [{ symbol: "BTC-USDT", from: "2026-01-01", to: "2026-02-01", bars30m: u.length, signals: n }], rows };
  assert.match(btcStudyText(report), /BTC-USDT · шорты/);
});
