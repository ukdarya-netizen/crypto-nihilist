/**
 * Pure part of the reports (schedule and texts; no DB).
 * Daily / weekly / monthly reports in the AltBullet layout, sent to the
 * channel and every /start subscriber through the same delivery queue as
 * signals (reports use negative event ids, so they never collide).
 * Schedule (Samara/Dubai, UTC+4, as AltBullet):
 *   daily   — every day 22:00, trades closed since local midnight;
 *   weekly  — Sunday 10:00, trades closed in the last 7 days;
 *   monthly — 1st day 11:00, trades closed in the previous calendar month.
 * A report missed by a restart is sent late, within 24 h of its time; each
 * period is claimed once in nh_state, so it is never sent twice.
 * Only live trades (sent to Telegram) are counted. Plain text, no HTML.
 * Owner 2026-11-11: reports carry CLOSED trades only, each with how long it was active — open positions are
 * never listed, so nobody outside the subscription can follow live signals by coin from the reports.
 */
import { beBucket, tradeStatus, type JournalRow } from "../stats/journal";
import { fmtPct } from "./format";

const TZ_MS = 4 * 3_600_000;
const DAY = 86_400_000;

export type ReportKind = "daily" | "weekly" | "monthly";
export type Schedule = { kind: ReportKind; at: number; from: number; to: number; period: number };

/** The most recent scheduled time of a report at or before `now` (UTC ms). */
export function latestSchedule(kind: ReportKind, now: number): Schedule {
  const localDay = Math.floor((now + TZ_MS) / DAY);
  const dayStartUtc = (d: number) => d * DAY - TZ_MS;
  if (kind === "daily") {
    let d = localDay;
    if (dayStartUtc(d) + 22 * 3_600_000 > now) d -= 1;
    const at = dayStartUtc(d) + 22 * 3_600_000;
    return { kind, at, from: dayStartUtc(d), to: at, period: d };
  }
  if (kind === "weekly") {
    // 1970-01-01 was a Thursday: (day + 4) % 7 === 0 is Sunday.
    let d = localDay - ((localDay + 4) % 7);
    if (dayStartUtc(d) + 10 * 3_600_000 > now) d -= 7;
    const at = dayStartUtc(d) + 10 * 3_600_000;
    return { kind, at, from: at - 7 * DAY, to: at, period: d };
  }
  const local = new Date(now + TZ_MS);
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth();
  const monthStart = (yy: number, mm: number) => Date.UTC(yy, mm, 1) - TZ_MS;
  if (monthStart(y, m) + 11 * 3_600_000 > now) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const at = monthStart(y, m) + 11 * 3_600_000;
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 11 : m - 1;
  return { kind, at, from: monthStart(prevY, prevM), to: monthStart(y, m), period: prevY * 12 + prevM };
}

/** Delivery-queue id of a report: negative, unique per kind and period. */
export function reportEventId(s: Schedule): number {
  const base = s.kind === "daily" ? 100_000_000 : s.kind === "weekly" ? 200_000_000 : 300_000_000;
  return -(base + s.period);
}

export type ReportRow = JournalRow & { entry: number; last_price: number | null };

type Lang = "ru" | "en";
const coin = (s: string) => s.replace(/-USDT$/, "");
const sideOf = (lang: Lang) => (s: string) => (lang === "en" ? (s === "long" ? "long" : "short") : s === "long" ? "лонг" : "шорт");
const pnl = (r: ReportRow) => Number(r.pnl_pct ?? 0);
const net = (rows: ReportRow[]) => fmtPct(rows.reduce((a, r) => a + pnl(r), 0));
/** How long a closed trade was active (opened → closed), e.g. "2d 5h", "3h 20m", "45m". */
export function activeFor(r: ReportRow, lang: Lang = "en"): string {
  const ms = new Date(r.closed_at ?? r.opened_at).getTime() - new Date(r.opened_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return durationText(ms, lang);
}
function durationText(ms: number, lang: Lang): string {
  const [d, h, m] = lang === "en" ? ["d", "h", "m"] : ["д", "ч", "м"];
  const mins = Math.round(ms / 60_000);
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), rest = mins % 60;
  if (days > 0) return `${days}${d} ${hours}${h}`;
  if (hours > 0) return `${hours}${h} ${rest}${m}`;
  return `${rest}${m}`;
}
/** Shortest … longest active time of a group (ranges, never a median). */
function activeRange(rows: ReportRow[], lang: Lang): string | null {
  const ms = rows
    .map((r) => new Date(r.closed_at ?? r.opened_at).getTime() - new Date(r.opened_at).getTime())
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (!ms.length) return null;
  const lo = durationText(Math.min(...ms), lang), hi = durationText(Math.max(...ms), lang);
  return lo === hi ? lo : `${lo} – ${hi}`;
}
const dateOf = (lang: Lang) => (ms: number, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleString(lang === "en" ? "en-GB" : "ru-RU", { timeZone: "Europe/Samara", ...opts });
const T = {
  ru: { active: "активна", activeFor: "в позиции", profit: "Профит", stop: "Стоп-лосс", peak: "пик", upTo5: "до +5%", after: "после", total: "Общий PnL", closed: "закрыто", open: "Открыто",
    noTradesToday: "Сегодня сделок не было.", noClosedToday: "Сегодня закрытых сделок нет.", weekly: "Недельный отчёт", monthly: "Месячный отчёт",
    noWeek: "За последние 7 дней закрытых сделок не было.", noMonth: "В этом месяце закрытых сделок не было.", top3: "Топ-3 по профиту:" },
  en: { active: "active", activeFor: "active", profit: "Profit", stop: "Stop loss", peak: "peak", upTo5: "under +5%", after: "after", total: "Total PnL", closed: "closed", open: "Open",
    noTradesToday: "No trades today.", noClosedToday: "No closed trades today.", weekly: "Weekly report", monthly: "Monthly report",
    noWeek: "No closed trades in the last 7 days.", noMonth: "No closed trades this month.", top3: "Top 3 by profit:" },
} as const;

function outcomeBlock(closed: ReportRow[], withList: boolean, lang: Lang = "en"): string[] {
  const t = T[lang]; const side = sideOf(lang);
  const by = (s: string) => closed.filter((r) => tradeStatus(r) === s);
  const profit = by("profit");
  const be = by("be_stop");
  const stop = by("stop_loss");
  const expired = by("expired");
  const lines: string[] = [];
  // Daily: every closed trade by name with its active time. Weekly / monthly: the active-time range per group.
  const list = (rows: ReportRow[]) => {
    if (withList) {
      for (const r of rows)
        lines.push(`  • ${coin(r.symbol)} ${side(r.side)} ${fmtPct(pnl(r))} | ${t.peak} ${fmtPct(Number(r.peak_pct ?? 0))} | ${t.active} ${activeFor(r, lang)}`);
    } else {
      const range = activeRange(rows, lang);
      if (range) lines.push(`  • ${t.activeFor}: ${range}`);
    }
  };
  lines.push(`✅ ${t.profit}: ${profit.length} | PnL: ${net(profit)}`);
  list(profit);
  lines.push(`❌ ${t.stop}: ${stop.length} | PnL: ${net(stop)}`);
  list(stop);
  lines.push(`🛡 BE: ${be.length} | PnL: ${net(be)}`);
  list(be);
  const lt5 = be.filter((r) => beBucket(r) === "lt5");
  if (lt5.length) lines.push(`  • ${t.upTo5}: ${lt5.length} | PnL: ${net(lt5)}`);
  for (const g of ["5", "8", "10"] as const) {
    const grp = be.filter((r) => beBucket(r) === g);
    lines.push(`  • ${t.after} +${g}%: ${grp.length} | PnL: ${net(grp)}`);
  }
  lines.push(`⏳ Expired: ${expired.length} | PnL: ${net(expired)}`);
  list(expired);
  const wins = profit.length + be.length;
  const denom = wins + stop.length;
  lines.push(``, `💰 ${t.total}: ${net(closed)}`);
  lines.push(`Win rate: ${denom ? `${Math.round((wins / denom) * 100)}%` : "—"} · ${t.closed}: ${closed.length}`);
  return lines;
}

export function formatDailyReport(closed: ReportRow[], at: number, lang: Lang = "en"): string {
  const t = T[lang]; const dateRu = dateOf(lang);
  const lines = [`📊 DAILY REPORT — NIHILYST`, dateRu(at, { day: "2-digit", month: "long", year: "numeric" }), ``];
  if (!closed.length) {
    lines.push(t.noClosedToday);
  } else {
    lines.push(...outcomeBlock(closed, true, lang));
  }
  lines.push(``, lang === "en" ? "#daily_report" : `#ежедневный_отчет #daily_report`);
  return lines.join("\n");
}

export function formatPeriodReport(kind: "weekly" | "monthly", closed: ReportRow[], from: number, to: number, lang: Lang = "en"): string {
  const t = T[lang]; const side = sideOf(lang); const dateRu = dateOf(lang);
  const title = kind === "weekly" ? t.weekly : t.monthly;
  const period = kind === "weekly"
    ? `${dateRu(from, { day: "2-digit", month: "2-digit" })} – ${dateRu(to - 1, { day: "2-digit", month: "2-digit", year: "numeric" })}`
    : dateRu(from, { month: "long", year: "numeric" });
  const lines = [`📊 ${title} — NIHILYST`, period, ``];
  if (!closed.length) {
    lines.push(kind === "weekly" ? t.noWeek : t.noMonth);
  } else {
    const top = closed.filter((r) => pnl(r) > 0).sort((a, b) => pnl(b) - pnl(a)).slice(0, 3);
    if (top.length) {
      const medals = ["🥇", "🥈", "🥉"];
      lines.push(`🏆 ${t.top3}`);
      top.forEach((r, i) => lines.push(`${medals[i]} ${coin(r.symbol)} ${side(r.side)} ${fmtPct(pnl(r))} | ${t.active} ${activeFor(r, lang)}`));
      lines.push(``);
    }
    lines.push(...outcomeBlock(closed, false, lang));
  }
  lines.push(``, lang === "en" ? (kind === "weekly" ? "#weekly_report" : "#monthly_report")
    : kind === "weekly" ? "#еженедельный_отчет #weekly_report" : "#ежемесячный_отчет #monthly_report");
  return lines.join("\n");
}

