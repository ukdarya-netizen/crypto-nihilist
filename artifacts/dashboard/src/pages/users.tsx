/** Owner: access requests and subscriptions (as the CAB «Пользователи» page). */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Ban, Check, Clock, Loader2, RefreshCw, Search, ShieldCheck, Trash2, UserCheck, X } from "lucide-react";
import { del, get, patch } from "../lib/api";

type User = {
  id: number; email: string; name: string; chatId: string | null; telegramUsername: string | null;
  subscribedUntil: string | null; status: "pending" | "approved" | "expired" | "blocked"; notify: boolean; owner: boolean;
  createdAt: string; approvedAt: string | null; lastLoginAt: string | null;
};
type Tab = "pending" | "approved" | "expired" | "blocked" | "all";
const TZ = "Asia/Dubai";

const fmtDate = (s: string | null) =>
  !s ? "—" : new Date(s).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "2-digit", timeZone: TZ });

function toDateInput(s: string | null): string {
  if (!s) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(s)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const BADGE: Record<User["status"], { cls: string; label: string; icon: typeof Clock }> = {
  pending: { cls: "text-warn border-warn/30 bg-warn/10", label: "Ожидает", icon: Clock },
  approved: { cls: "text-up border-up/30 bg-up/10", label: "Активен", icon: UserCheck },
  expired: { cls: "text-down border-down/30 bg-down/10", label: "Подписка истекла", icon: Clock },
  blocked: { cls: "text-down border-down/30 bg-down/10", label: "Заблок.", icon: Ban },
};

function Row({ u, refresh }: { u: User; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [date, setDate] = useState(toDateInput(u.subscribedUntil));
  const [chat, setChat] = useState(u.chatId ?? "");
  const [err, setErr] = useState("");
  useEffect(() => setDate(toDateInput(u.subscribedUntil)), [u.subscribedUntil]);
  useEffect(() => { setChat(u.chatId ?? ""); setErr(""); }, [u.chatId]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr("");
    try { await fn(); refresh(); } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка"); }
    setBusy(null);
  };
  const act = (a: "approve" | "block" | "delete") => {
    if (a === "delete" && !window.confirm(`Удалить ${u.name}?`)) return;
    void run(a, () => (a === "delete" ? del(`/admin/users/${u.id}`) : patch(`/admin/users/${u.id}`, { status: a === "approve" ? "approved" : "blocked" })));
  };
  const saveDate = (v: string) => void run("date", () => patch(`/admin/users/${u.id}`, { subscribedUntil: v ? `${v}T00:00:00+04:00` : null }));
  const saveChat = (v: string) => {
    if (v.trim() === (u.chatId ?? "")) return;
    void run("chat", () => patch(`/admin/users/${u.id}`, { chatId: v.trim() || null }).catch((e) => { setChat(u.chatId ?? ""); throw e; }));
  };
  const expired = u.status === "expired";
  const b = BADGE[u.status];
  const Icon = b.icon;
  const tg = [u.telegramUsername ? `@${u.telegramUsername}` : null, u.chatId ? `ID ${u.chatId}` : null].filter(Boolean).join(" · ");
  const spin = (k: string, el: ReactElement) => (busy === k ? <Loader2 className="size-3.5 animate-spin" /> : el);

  return (
    <div className="border-b border-border px-4 py-3 last:border-0 hover:bg-white/[0.02]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{u.name}{u.owner && <ShieldCheck className="ml-1.5 inline size-3.5 text-primary" />}</p>
          <p className="truncate text-xs text-muted">{u.email}</p>
          {tg && <p className="truncate font-mono text-xs text-muted/70">{tg}{!u.notify && " · сигналы выкл"}</p>}
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 text-xs text-muted sm:flex">
          <span>Запрос: {fmtDate(u.createdAt)}</span>
          {u.lastLoginAt && <span>Вход: {fmtDate(u.lastLoginAt)}</span>}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 border px-2 py-0.5 text-xs ${b.cls}`}><Icon className="size-3" />{b.label}</span>
        {!u.owner && (
          <div className="flex shrink-0 items-center gap-0.5">
            {u.status !== "approved" && <button title="Одобрить" disabled={!!busy} onClick={() => act("approve")} className="grid size-7 place-items-center text-up hover:bg-up/10">{spin("approve", <Check className="size-3.5" />)}</button>}
            {u.status !== "blocked" && <button title="Заблокировать" disabled={!!busy} onClick={() => act("block")} className="grid size-7 place-items-center text-warn hover:bg-warn/10">{spin("block", <X className="size-3.5" />)}</button>}
            <button title="Удалить" disabled={!!busy} onClick={() => act("delete")} className="grid size-7 place-items-center text-down hover:bg-down/10">{spin("delete", <Trash2 className="size-3.5" />)}</button>
          </div>
        )}
      </div>
      {!u.owner && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Подписка до (Дубай):</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} onBlur={(e) => saveDate(e.target.value)}
            className={`h-6 border bg-transparent px-1.5 ${expired ? "border-down/50 text-down" : "border-border"}`} />
          {busy === "date" && <Loader2 className="size-3 animate-spin text-muted" />}
          {date && <button title="Очистить" onClick={() => { setDate(""); saveDate(""); }} className="text-muted hover:text-down"><X className="size-3" /></button>}
          {u.subscribedUntil && !expired && <span className="text-up">✓ активна</span>}
          {expired && <span className="text-down">истекла</span>}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Telegram Chat ID:</span>
        <input inputMode="numeric" value={chat} onChange={(e) => { setChat(e.target.value); setErr(""); }} onBlur={(e) => saveChat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder="Например, 6964248629"
          className="h-6 w-44 border border-border bg-transparent px-1.5 font-mono" />
        {busy === "chat" && <Loader2 className="size-3 animate-spin text-muted" />}
        {err && <span className="text-down">{err}</span>}
      </div>
    </div>
  );
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("pending");
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await get<User[]>("/admin/users")); } catch { /* shown as empty */ }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const count = (s: User["status"]) => users.filter((u) => u.status === s).length;
  const needle = q.trim().toLowerCase().replace(/^@/, "");
  const shown = users
    .filter((u) => tab === "all" || u.status === tab)
    .filter((u) => !needle || [u.email, u.name, u.chatId ?? "", u.telegramUsername ?? ""].some((v) => v.toLowerCase().includes(needle)));
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "pending", label: `Ожидают${count("pending") ? ` (${count("pending")})` : ""}` },
    { key: "approved", label: "Активные" },
    { key: "expired", label: `EXPIRED${count("expired") ? ` (${count("expired")})` : ""}` },
    { key: "blocked", label: "Заблок." },
    { key: "all", label: `Все (${users.length})` },
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Запросы доступа и подписки. Одобрение в Telegram открывает 1 месяц; дату можно поменять здесь.</p>
        <button title="Обновить" onClick={() => void load()} className="grid size-8 place-items-center border border-border text-muted hover:text-foreground">
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`h-8 border px-3 text-xs ${tab === t.key ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}>{t.label}</button>
        ))}
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по email, Chat ID, @ник или имени…"
          className="h-10 w-full border border-border bg-background pl-9 pr-9 text-sm outline-none focus:border-primary" />
        {q && <button onClick={() => setQ("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted"><X className="size-4" /></button>}
      </div>
      <div className="panel">
        {shown.length ? shown.map((u) => <Row key={u.id} u={u} refresh={() => void load()} />)
          : <p className="px-4 py-8 text-center text-sm text-muted">{loading ? "Загрузка…" : "Нет пользователей"}</p>}
      </div>
    </div>
  );
}
