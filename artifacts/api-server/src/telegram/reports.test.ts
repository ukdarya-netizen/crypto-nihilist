import assert from "node:assert/strict";
import test from "node:test";
import { formatDailyReport, formatPeriodReport, latestSchedule, reportEventId, type ReportRow } from "./report-format";
import { LIVE_SETUPS } from "../engine/config";

const H = 3_600_000;
// 2026-10-25 is a Sunday. Samara = UTC+4.
const at = (iso: string) => Date.parse(iso);

test("all 8 setups are live (full forward test)", () => {
  assert.equal(LIVE_SETUPS.size, 8);
  for (const s of ["4h_30m_long", "4h_1h_short", "1d_30m_short", "1d_1h_long"]) assert.ok(LIVE_SETUPS.has(s), s);
});

test("daily: 22:00 Samara, trades since local midnight", () => {
  const before = latestSchedule("daily", at("2026-10-25T17:59:00Z"));
  assert.equal(new Date(before.at).toISOString(), "2026-10-24T18:00:00.000Z");
  const after = latestSchedule("daily", at("2026-10-25T18:00:00Z"));
  assert.equal(new Date(after.at).toISOString(), "2026-10-25T18:00:00.000Z");
  assert.equal(new Date(after.from).toISOString(), "2026-10-24T20:00:00.000Z");
  assert.notEqual(reportEventId(before), reportEventId(after));
});

test("weekly: Sunday 10:00 Samara over the last 7 days", () => {
  const s = latestSchedule("weekly", at("2026-10-25T06:30:00Z"));
  assert.equal(new Date(s.at).toISOString(), "2026-10-25T06:00:00.000Z");
  assert.equal(s.to - s.from, 7 * 24 * H);
  const early = latestSchedule("weekly", at("2026-10-25T05:00:00Z"));
  assert.equal(new Date(early.at).toISOString(), "2026-10-18T06:00:00.000Z");
});

test("monthly: 1st 11:00 Samara over the previous calendar month", () => {
  const s = latestSchedule("monthly", at("2026-11-01T08:00:00Z"));
  assert.equal(new Date(s.at).toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(new Date(s.from).toISOString(), "2026-09-30T20:00:00.000Z");
  assert.equal(new Date(s.to).toISOString(), "2026-10-31T20:00:00.000Z");
  const jan = latestSchedule("monthly", at("2027-01-01T08:00:00Z"));
  assert.equal(new Date(jan.from).toISOString(), "2026-11-30T20:00:00.000Z");
  assert.ok(reportEventId(s) < 0 && reportEventId(jan) < 0);
});

const row = (over: Partial<ReportRow>): ReportRow => ({
  id: 1, symbol: "JCT-USDT", setup: "4h_30m_long", side: "long", status: "closed", live: true,
  close_reason: "trailing", pnl_pct: 20, r_multiple: 3, peak_pct: 30, mfe_pct: 30,
  opened_at: "2026-10-25T01:00:00Z", closed_at: "2026-10-25T12:00:00Z", entry: 1, last_price: 1.2, ...over,
});

test("daily text: open, profit list, BE 5/8/10, stop, win rate; plain text", () => {
  const text = formatDailyReport([
    row({}),
    row({ id: 2, symbol: "ABC-USDT", close_reason: "breakeven", pnl_pct: 4, peak_pct: 8.5 }),
    row({ id: 3, symbol: "XYZ-USDT", side: "short", close_reason: "stop", pnl_pct: -6, peak_pct: 1 }),
  ], [row({ id: 4, symbol: "OPN-USDT", status: "open", close_reason: null, pnl_pct: null, entry: 2, last_price: 2.2 })],
  at("2026-10-25T18:00:00Z"));
  assert.match(text, /DAILY REPORT — NIHILYST/);
  assert.match(text, /OPN лонг \| 2 → 2\.2 \(\+10\.0%\)/);
  assert.match(text, /✅ Профит: 1 \| PnL: \+20\.0%/);
  assert.match(text, /JCT лонг \+20\.0% \| пик \+30\.0%/);
  assert.match(text, /после \+8%: 1 \| PnL: \+4\.0%/);
  assert.match(text, /❌ Стоп-лосс: 1 \| PnL: −6\.0%/);
  assert.match(text, /Общий PnL: \+18\.0%/);
  assert.match(text, /Win rate: 67%/);
  assert.doesNotMatch(text, /<\/?[a-z]+>/);
});

test("weekly and monthly: top-3 and empty texts", () => {
  const w = formatPeriodReport("weekly", [row({}), row({ id: 2, symbol: "B-USDT", pnl_pct: 30 })],
    at("2026-10-18T06:00:00Z"), at("2026-10-25T06:00:00Z"));
  assert.match(w, /Недельный отчёт — NIHILYST/);
  assert.match(w, /🥇 B лонг \+30\.0%\n🥈 JCT лонг \+20\.0%/);
  assert.match(w, /#еженедельный_отчет/);
  const m = formatPeriodReport("monthly", [], at("2026-09-30T20:00:00Z"), at("2026-10-31T20:00:00Z"));
  assert.match(m, /октябрь 2026/);
  assert.match(m, /В этом месяце закрытых сделок не было\./);
});
