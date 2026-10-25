/**
 * Pure part of the reports (schedule and texts; no DB).
 * Daily / weekly / monthly reports in the AltBullet layout, sent to the
 * channel and every /start subscriber through the same delivery queue as
 * signals (reports use negative event ids, so they never collide).
 * Schedule (Samara/Dubai, UTC+4, as AltBullet):
 *   daily   — every day 22:00, trades closed since local midnight + open ones;
 *   weekly  — Sunday 10:00, trades closed in the last 7 days;
 *   monthly — 1st day 11:00, trades closed in the previous calendar month.
 * A report missed by a restart is sent late, within 24 h of its time; each
 * period is claimed once in nh_state, so it is never sent twice.
 * Only live trades (sent to Telegram) are counted. Plain text, no HTML.
 */
import { beBucket, tradeStatus, type JournalRow } from "../stats/journal";
import { fmtP, fmtPct } from "./format";

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

const coin = (s: string) => s.replace(/-USDT$/, "");
const side = (s: string) => (s === "long" ? "лонг" : "шорт");
const pnl = (r: ReportRow) => Number(r.pnl_pct ?? 0);
const net = (rows: ReportRow[]) => fmtPct(rows.reduce((a, r) => a + pnl(r), 0));
const livePct = (r: ReportRow) =>
  r.last_price === null ? null : ((Number(r.last_price) - r.entry) / r.entry) * 100 * (r.side === "long" ? 1 : -1);
const dateRu = (ms: number, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleString("ru-RU", { timeZone: "Europe/Samara", ...opts });

function outcomeBlock(closed: ReportRow[], withList: boolean): string[] {
  const by = (s: string) => closed.filter((r) => tradeStatus(r) === s);
  const profit = by("profit");
  const be = by("be_stop");
  const stop = by("stop_loss");
  const expired = by("expired");
  const lines: string[] = [];
  lines.push(`✅ Профит: ${profit.length} | PnL: ${net(profit)}`);
  if (withList) for (const r of profit) lines.push(`  • ${coin(r.symbol)} ${side(r.side)} ${fmtPct(pnl(r))} | пик ${fmtPct(Number(r.peak_pct ?? 0))}`);
  lines.push(`❌ Стоп-лосс: ${stop.length} | PnL: ${net(stop)}`);
  lines.push(`🛡 BE: ${be.length} | PnL: ${net(be)}`);
  const lt5 = be.filter((r) => beBucket(r) === "lt5");
  if (lt5.length) lines.push(`  • до +5%: ${lt5.length} | PnL: ${net(lt5)}`);
  for (const g of ["5", "8", "10"] as const) {
    const grp = be.filter((r) => beBucket(r) === g);
    lines.push(`  • после +${g}%: ${grp.length} | PnL: ${net(grp)}`);
  }
  lines.push(`⏳ Expired: ${expired.length} | PnL: ${net(expired)}`);
  const wins = profit.length + be.length;
  const denom = wins + stop.length;
  lines.push(``, `💰 Общий PnL: ${net(closed)}`);
  lines.push(`Win rate: ${denom ? `${Math.round((wins / denom) * 100)}%` : "—"} · закрыто: ${closed.length}`);
  return lines;
}

export function formatDailyReport(closed: ReportRow[], open: ReportRow[], at: number): string {
  const lines = [`📊 DAILY REPORT — NIHILYST`, dateRu(at, { day: "2-digit", month: "long", year: "numeric" }), ``];
  if (open.length) {
    lines.push(`📂 Открыто: ${open.length}`);
    for (const r of open) {
      const p = livePct(r);
      lines.push(`  • ${coin(r.symbol)} ${side(r.side)} | ${fmtP(r.entry)} → ${r.last_price === null ? "—" : fmtP(Number(r.last_price))}${p === null ? "" : ` (${fmtPct(p)})`}`);
    }
    lines.push(``);
  }
  if (!closed.length && !open.length) {
    lines.push(`Сегодня сделок не было.`);
  } else if (!closed.length) {
    lines.push(`Сегодня закрытых сделок нет.`);
  } else {
    lines.push(...outcomeBlock(closed, true));
  }
  lines.push(``, `#ежедневный_отчет #daily_report`);
  return lines.join("\n");
}

export function formatPeriodReport(kind: "weekly" | "monthly", closed: ReportRow[], from: number, to: number): string {
  const title = kind === "weekly" ? "Недельный отчёт" : "Месячный отчёт";
  const period = kind === "weekly"
    ? `${dateRu(from, { day: "2-digit", month: "2-digit" })} – ${dateRu(to - 1, { day: "2-digit", month: "2-digit", year: "numeric" })}`
    : dateRu(from, { month: "long", year: "numeric" });
  const lines = [`📊 ${title} — NIHILYST`, period, ``];
  if (!closed.length) {
    lines.push(kind === "weekly" ? "За последние 7 дней закрытых сделок не было." : "В этом месяце закрытых сделок не было.");
  } else {
    const top = closed.filter((r) => pnl(r) > 0).sort((a, b) => pnl(b) - pnl(a)).slice(0, 3);
    if (top.length) {
      const medals = ["🥇", "🥈", "🥉"];
      lines.push(`🏆 Топ-3 по профиту:`);
      top.forEach((r, i) => lines.push(`${medals[i]} ${coin(r.symbol)} ${side(r.side)} ${fmtPct(pnl(r))}`));
      lines.push(``);
    }
    lines.push(...outcomeBlock(closed, false));
  }
  lines.push(``, kind === "weekly" ? "#еженедельный_отчет #weekly_report" : "#ежемесячный_отчет #monthly_report");
  return lines.join("\n");
}

