import { useEffect, useState, type ReactNode } from "react";
import { Activity, BookOpen, HeartPulse, History, MoreHorizontal, ScanSearch, Target, X } from "lucide-react";
import { BrandLockup, BrandMark, SLOGAN, Wordmark } from "./brand";
import { usePoll, type Status } from "../lib/api";

export type Route = "/" | "/tracker" | "/scanner" | "/history" | "/health" | "/reference";

export const NAV: Array<{ href: Route; label: string; sub: string; icon: typeof Target }> = [
  { href: "/tracker", label: "Открытые позиции", sub: "мониторинг ТП / стопов", icon: Target },
  { href: "/", label: "Обзор", sub: "общая статистика", icon: Activity },
  { href: "/scanner", label: "Сканер", sub: "решения по циклам", icon: ScanSearch },
  { href: "/history", label: "История сигналов", sub: "закрытые сделки", icon: History },
  { href: "/health", label: "Bot Health", sub: "движок · CoinGlass", icon: HeartPulse },
  { href: "/reference", label: "Справочник", sub: "сетапы · правила", icon: BookOpen },
];

export function useRoute(): Route {
  const read = (): Route => {
    const hash = window.location.hash.replace(/^#/, "") || "/";
    return (NAV.some((n) => n.href === hash) ? hash : "/") as Route;
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
  const ago = data?.engine.lastCycleAt ? (Date.now() - data.engine.lastCycleAt) / 60_000 : null;
  const items: Array<{ label: string; ok: boolean | null }> = [
    { label: "Движок", ok: data ? data.engine.leaseAcquired && ago !== null && ago <= 35 : null },
    { label: "CoinGlass", ok: data ? !cg || cg.consecutiveFailures < 5 : null },
    { label: "Telegram", ok: data?.telegram?.configured ? true : null },
  ];
  return (
    <div className="space-y-1.5 border-t border-border p-4 font-mono text-[11px] text-muted">
      {items.map(({ label, ok }) => (
        <div key={label} className="flex items-center justify-between">
          <span>{label}</span>
          <span className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${ok === null ? "bg-zinc-600" : ok ? "bg-up" : "bg-primary"}`} />
            <span className={ok === null ? "text-zinc-500" : ok ? "text-up" : "text-primary"}>
              {ok === null ? (label === "Telegram" ? "выкл" : "…") : ok ? "OK" : "ERR"}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function MobileNav({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const primary = NAV.filter((n) => n.href === "/tracker" || n.href === "/");
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/70 md:hidden" onClick={() => setOpen(false)}>
          <div className="panel absolute inset-x-3 bottom-20 p-2" onClick={(e) => e.stopPropagation()}>
            {NAV.map((n) => {
              const Icon = n.icon;
              return (
                <a key={n.href} href={`#${n.href}`} onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 border border-transparent px-3 py-3 text-sm ${route === n.href ? "nav-active" : "text-muted"}`}>
                  <Icon className="size-4" />{n.label}
                </a>
              );
            })}
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
          {open ? <X className="size-5" /> : <MoreHorizontal className="size-5" />}Ещё
        </button>
      </nav>
    </>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const current = NAV.find((n) => n.href === route) ?? NAV[1];
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/80 md:flex">
        <div className="flex h-20 items-center border-b border-border px-5 bg-[linear-gradient(110deg,rgba(227,38,46,.14),transparent_70%)]">
          <BrandLockup />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = route === n.href;
            return (
              <a key={n.href} href={`#${n.href}`}
                className={`flex items-start border border-transparent px-3 py-2.5 text-sm font-medium transition-colors ${active ? "nav-active" : "text-muted hover:bg-white/[0.03] hover:text-foreground"}`}>
                <Icon className={`mr-3 mt-0.5 size-4 shrink-0 ${active ? "text-primary" : ""}`} />
                <span className="flex flex-col">
                  <span>{n.label}</span>
                  <span className={`text-xs font-normal ${active ? "text-foreground/50" : "text-muted/60"}`}>{n.sub}</span>
                </span>
              </a>
            );
          })}
        </nav>
        <p className="px-5 pb-3 font-type text-[10px] leading-relaxed tracking-[0.18em] text-primary/80">{SLOGAN}</p>
        <ApiDots />
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
          <div className="hidden font-mono text-xs text-muted md:block"><Clock /></div>
        </header>
        <div className="flex-1 overflow-auto p-4 pb-24 md:p-8">{children}</div>
      </main>
      <MobileNav route={route} />
    </div>
  );
}
