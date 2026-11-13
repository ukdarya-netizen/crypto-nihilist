import { useEffect, useState, type ReactNode } from "react";
import { Activity, Ban, Bitcoin, BookOpen, CandlestickChart, FlaskConical, HeartPulse, History, LogOut, MoreHorizontal, ScanSearch, Target, Users, X } from "lucide-react";
import { LanguageToggle } from "./language-toggle";
import { BrandLockup, BrandMark, SLOGAN, Wordmark } from "./brand";
import { STAGE_LABEL, currentSession, dur, get, isOwner, post, saveSession, usePoll, type Status } from "../lib/api";

export type Route = "/" | "/tracker" | "/scanner" | "/rejections" | "/history" | "/metrics" | "/btc" | "/health" | "/reference" | "/members" | "/strategies"
  | "/login" | "/register" | "/reset-password";
export const PUBLIC_ROUTES: Route[] = ["/login", "/register", "/reset-password"];

export const NAV: Array<{ href: Route; label: string; sub: string; icon: typeof Target }> = [
  { href: "/tracker", label: "Открытые позиции", sub: "мониторинг ТП / стопов", icon: Target },
  { href: "/", label: "Обзор", sub: "общая статистика", icon: Activity },
  { href: "/scanner", label: "Сканер", sub: "кандидаты · циклы", icon: ScanSearch },
  { href: "/rejections", label: "Отклонённые сигналы", sub: "причины · что было дальше", icon: Ban },
  { href: "/history", label: "История сигналов", sub: "закрытые сделки", icon: History },
  { href: "/metrics", label: "Метрики входа", sub: "что отличает прибыль от стопа", icon: FlaskConical },
  // Owner 2026-11-13 (as CAB): BTC and its dominance as the context of our trades.
  { href: "/btc", label: "BTC", sub: "контекст рынка · BTC.D", icon: Bitcoin },
  { href: "/health", label: "Bot Health", sub: "движок · CoinGlass", icon: HeartPulse },
  { href: "/reference", label: "Справочник", sub: "сетапы · правила", icon: BookOpen },
];
/** Owner only (as CAB «Подписчики»). */
export const OWNER_NAV: typeof NAV = [
  { href: "/strategies", label: "Стратегии торговли", sub: "как вести сделки в торговом боте", icon: CandlestickChart },
  { href: "/members", label: "Подписчики", sub: "дашборд + Telegram-бот", icon: Users },
];

/** Owner: pending access requests for the «+N» badge (as CAB), every 60 s. */
function usePendingCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (currentSession()?.role !== "owner") return;
    const load = () => void get<{ count: number }>("/admin/users/pending-count").then((d) => setN(d.count)).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  return n;
}

/** Presence (as CAB): heartbeat every 30 s while the tab is visible. */
function useHeartbeat(): void {
  useEffect(() => {
    const beat = () => { if (document.visibilityState === "visible" && currentSession()) void post("/auth/heartbeat", {}).catch(() => undefined); };
    beat();
    const t = setInterval(beat, 30_000);
    document.addEventListener("visibilitychange", beat);
    window.addEventListener("focus", beat);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", beat); window.removeEventListener("focus", beat); };
  }, []);
}

const PendingBadge = ({ href, n }: { href: Route; n: number }) =>
  href === "/members" && n > 0 ? <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">+{n}</span> : null;

/** Owner-only pages (users do not see the scanner, research and engine health). */
export const OWNER_ROUTES: Route[] = ["/scanner", "/rejections", "/metrics", "/health", "/members", "/strategies"];

function navFor(): typeof NAV {
  return isOwner() ? [...NAV, ...OWNER_NAV] : NAV.filter((n) => !OWNER_ROUTES.includes(n.href));
}

/** Query of the hash route (#/history?status=profit&days=30). */
export function hashParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "");
}

export function logout(): void {
  saveSession(null);
  window.location.hash = "/login";
}

export function useRoute(): Route {
  const read = (): Route => {
    // A filter may follow the page: #/history?status=profit (overview tiles open the history, as in CAB).
    let hash = window.location.hash.replace(/^#/, "").split("?")[0] || "/";
    if (hash === "/users") hash = "/members";
    return ([...NAV, ...OWNER_NAV].some((n) => n.href === hash) || PUBLIC_ROUTES.includes(hash as Route) ? hash : "/") as Route;
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <span>SYS_TIME: {now.toISOString().slice(11, 19)} UTC</span>;
}

function ApiDots() {
  const { data } = usePoll<Status>("/nh/status", 30_000);
  const cg = data?.health.coinglass;
  const e = data?.engine;
  const ago = e?.lastCycleAt ? (Date.now() - e.lastCycleAt) / 60_000 : null;
  const sinceStart = e ? (Date.now() - e.startedAt) / 60_000 : null;
  // Healthy: a scan finished in the last 35 min, one is running now, or it is
  // still the first 40 minutes after a start (the first scan waits for a bar close).
  const engineOk = e ? e.leaseAcquired && (Boolean(e.cycle) || (ago !== null ? ago <= 35 : (sinceStart ?? 99) <= 40)) : null;
  // Private bot (no channel): signals go to registered users with access.
  const telegramLabel = !data ? "…" : !data.telegram?.configured ? "нет токена"
    : data.telegram.enabled === false ? "отправка выкл" : `получателей ${data.telegram.recipients ?? 0}`;
  const telegramOk = data ? Boolean(data.telegram?.configured && data.telegram.enabled !== false) : null;
  const items: Array<{ label: string; ok: boolean | null }> = [
    { label: "Движок", ok: engineOk },
    { label: "CoinGlass", ok: data ? !cg || cg.consecutiveFailures < 5 : null },
    { label: "Telegram", ok: telegramOk },
  ];
  return (
    <div className="space-y-1.5 border-t border-border p-4 font-mono text-[11px] text-muted">
      {items.map(({ label, ok }) => (
        <div key={label} className="flex items-center justify-between">
          <span>{label}</span>
          <span className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${ok === null ? "bg-zinc-600" : ok ? "bg-up" : "bg-primary"}`} />
            <span className={ok === null ? "text-zinc-500" : ok ? "text-up" : "text-primary"}>
              {label === "Telegram" ? telegramLabel : ok === null ? "…" : ok ? "OK" : "ERR"}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Positions and scan state, always visible (header on desktop, strip on phones). */
function ScanStrip({ compact = false }: { compact?: boolean }) {
  const { data } = usePoll<Status>("/nh/status", 10_000);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  if (!data) return null;
  const e = data.engine;
  const cur = e.cycle;
  const items = [
    <a key="pos" href="#/tracker" className="hover:text-foreground">позиций <b className="text-foreground">{data.signals.open}</b></a>,
    cur
      ? <span key="now" className="text-up">скан: {STAGE_LABEL[cur.stage]} {cur.done}/{cur.total} · {dur(Date.now() - cur.startedAt)}</span>
      : <span key="now">скан: ожидание</span>,
    <span key="last">прошлый: {e.lastCycleMs !== null ? dur(e.lastCycleMs) : "—"}</span>,
  ];
  return (
    <div className={`flex items-center gap-3 font-mono text-[11px] text-muted ${compact ? "flex-wrap" : ""}`}>
      {items.map((it, i) => <span key={i} className="flex items-center gap-3">{i > 0 && <span className="text-border">|</span>}{it}</span>)}
    </div>
  );
}

function MobileNav({ route, pending }: { route: Route; pending: number }) {
  const [open, setOpen] = useState(false);
  const primary = NAV.filter((n) => n.href === "/tracker" || n.href === "/");
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/70 md:hidden" onClick={() => setOpen(false)}>
          <div className="panel absolute inset-x-3 bottom-20 p-2" onClick={(e) => e.stopPropagation()}>
            {navFor().map((n) => {
              const Icon = n.icon;
              return (
                <a key={n.href} href={`#${n.href}`} onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 border border-transparent px-3 py-3 text-sm ${route === n.href ? "nav-active" : "text-muted"}`}>
                  <Icon className="size-4" /><span className="flex-1">{n.label}</span><PendingBadge href={n.href} n={pending} />
                </a>
              );
            })}
            <button type="button" onClick={() => { setOpen(false); logout(); }}
              className="flex w-full items-center gap-3 border border-transparent px-3 py-3 text-sm text-muted">
              <LogOut className="size-4" />Выйти{currentSession() ? ` (${currentSession()!.email})` : ""}
            </button>
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-50 grid h-16 grid-cols-3 border-t border-border bg-card/95 backdrop-blur md:hidden">
        {primary.map((n) => {
          const Icon = n.icon;
          return (
            <a key={n.href} href={`#${n.href}`} className={`flex flex-col items-center justify-center gap-1 text-[11px] ${route === n.href ? "text-primary" : "text-muted"}`}>
              <Icon className="size-5" />{n.href === "/tracker" ? "Позиции" : n.label}
            </a>
          );
        })}
        <button type="button" onClick={() => setOpen((v) => !v)} className={`flex flex-col items-center justify-center gap-1 text-[11px] ${open ? "text-primary" : "text-muted"}`}>
          <span className="relative">{open ? <X className="size-5" /> : <MoreHorizontal className="size-5" />}
            {pending > 0 && <span className="absolute -right-2 -top-1 size-2 rounded-full bg-primary" />}</span>Ещё
        </button>
      </nav>
    </>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const nav = navFor();
  const pending = usePendingCount();
  useHeartbeat();
  const current = nav.find((n) => n.href === route) ?? NAV[1];
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/80 md:flex">
        <div className="flex h-20 items-center border-b border-border px-5 bg-[linear-gradient(110deg,rgba(227,38,46,.14),transparent_70%)]">
          <BrandLockup />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {nav.map((n) => {
            const Icon = n.icon;
            const active = route === n.href;
            return (
              <a key={n.href} href={`#${n.href}`}
                className={`flex items-start border border-transparent px-3 py-2.5 text-sm font-medium transition-colors ${active ? "nav-active" : "text-muted hover:bg-white/[0.03] hover:text-foreground"}`}>
                <Icon className={`mr-3 mt-0.5 size-4 shrink-0 ${active ? "text-primary" : ""}`} />
                <span className="flex flex-1 flex-col">
                  <span className="flex items-center justify-between gap-2"><span>{n.label}</span><PendingBadge href={n.href} n={pending} /></span>
                  <span className={`text-xs font-normal ${active ? "text-foreground/50" : "text-muted/60"}`}>{n.sub}</span>
                </span>
              </a>
            );
          })}
        </nav>
        <button type="button" onClick={logout} title={currentSession()?.email}
          className="mx-3 mb-3 flex items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:text-foreground">
          <LogOut className="size-3.5" /><span className="truncate">Выйти · {currentSession()?.name ?? ""}</span>
        </button>
        <p className="px-5 pb-3 font-type text-[10px] leading-relaxed tracking-[0.18em] text-primary/80">{SLOGAN}</p>
        {isOwner() && <ApiDots />}
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/50 px-4 md:h-16 md:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark className="size-8 md:hidden" />
            <div className="min-w-0">
              <Wordmark className="mb-0.5 h-3.5 md:hidden" />
              <h1 className="truncate text-base font-semibold md:text-xl"><span className="slash relative z-0">{current.label}</span></h1>
            </div>
          </div>
          <div className="flex items-center gap-5 font-mono text-xs text-muted">
            <span className="hidden items-center gap-5 md:flex">{isOwner() && <ScanStrip />}<Clock /></span>
            <LanguageToggle />
          </div>
        </header>
        {isOwner() && <div className="border-b border-border px-4 py-1.5 md:hidden"><ScanStrip compact /></div>}
        <div className="flex-1 overflow-auto p-4 pb-24 md:p-8">{children}</div>
      </main>
      <MobileNav route={route} pending={pending} />
    </div>
  );
}
