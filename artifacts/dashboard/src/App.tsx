import { useEffect, useState, type ReactNode } from "react";

const PIN_KEY = "nihilist-pin";
const SETUP_LABEL: Record<string, string> = {
  "4h_30m_long": "ОБ 4h → слом 30m · лонг",
  "4h_30m_short": "ОБ 4h → слом 30m · шорт",
  "4h_1h_long": "ОБ 4h → слом 1h · лонг",
  "4h_1h_short": "ОБ 4h → слом 1h · шорт",
  "1d_30m_long": "ОБ 1D → слом 30m · лонг",
  "1d_30m_short": "ОБ 1D → слом 30m · шорт",
  "1d_1h_long": "ОБ 1D → слом 1h · лонг",
  "1d_1h_short": "ОБ 1D → слом 1h · шорт",
};
const CLOSE_LABEL: Record<string, string> = {
  tp2: "тейк 2", breakeven: "безубыток после тейка 1", stop: "стоп", timeout: "время вышло",
};
const REASON_LABEL: Record<string, string> = {
  rr_too_low: "первый тейк ближе 1R",
  risk_too_large: "стоп дальше 20%",
  stop_not_behind_entry: "стоп не за входом",
  open_signal_same_setup: "уже есть открытая сделка этого сетапа",
  accepted: "сигнал",
};

class PinError extends Error {}

function readPin(): string {
  try { return localStorage.getItem(PIN_KEY) ?? ""; } catch { return ""; }
}

async function get<T>(path: string, pin: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: pin ? { "x-dashboard-pin": pin } : {} });
  if (res.status === 401) throw new PinError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

type Status = {
  engine: {
    universe: number; ready: number; backfillPending: number; lastCycleAt: number | null; lastCycleMs: number | null;
    lastCycleRefreshFailed: number; lastCycleSignals: number; lastCycleDecisions: number; lastError: string | null;
    leaseAcquired: boolean;
  };
  coinglass: { ok: number; failed: number; rateLimited: number; keys: number };
  health: Record<string, { lastError: string | null; consecutiveFailures: number }>;
  signals: { open: number; closed: number };
};
type StatRow = {
  setup: string; trades: number; wins: number; tp1: number; stops: number; timeouts: number;
  avg_r: number | null; sum_r: number | null; avg_pnl_pct: number | null;
};
type Signal = {
  id: number; symbol: string; setup: string; side: string; entry: number; stop: number; tp1: number; tp2: number;
  risk_pct: number; rr1: number; opened_at: string; closed_at: string | null; close_reason: string | null;
  pnl_pct: number | null; r_multiple: number | null; tp1_hit: boolean; block_top: number; block_bottom: number;
  block_scope: string; targets_source: string;
};
type Decisions = { reasons7d: Array<{ reason: string; n: number }> };

function usePoll<T>(path: string, pin: string, ms = 15_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => get<T>(path, pin).then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e: Error) => { if (alive) setError(e); });
    void load();
    const timer = setInterval(load, ms);
    return () => { alive = false; clearInterval(timer); };
  }, [path, pin, ms]);
  return { data, error };
}

const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
const price = (v: number) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v > 0 ? "text-up" : v < 0 ? "text-down" : "");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const coin = (symbol: string) => symbol.replace(/-USDT$/, "");

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function PinGate({ onPin }: { onPin: (pin: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="mx-auto mt-24 max-w-xs border border-border bg-card p-6">
      <h1 className="mb-4 text-lg font-semibold">Crypto Nihilist</h1>
      <form onSubmit={(e) => { e.preventDefault(); onPin(value); }} className="space-y-3">
        <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="PIN"
          className="h-11 w-full border border-border bg-background px-3" autoFocus />
        <button className="h-11 w-full bg-accent font-semibold text-background">Войти</button>
      </form>
    </div>
  );
}

function StatusCard({ pin }: { pin: string }) {
  const { data } = usePoll<Status>("/nh/status", pin);
  if (!data) return <Card title="Состояние"><p className="text-muted">Загрузка…</p></Card>;
  const e = data.engine;
  const cg = data.health.coinglass;
  const ago = e.lastCycleAt ? Math.round((Date.now() - e.lastCycleAt) / 60_000) : null;
  const healthy = e.leaseAcquired && ago !== null && ago <= 35;
  return (
    <Card title="Состояние" right={<span className={healthy ? "text-up" : "text-warn"}>{healthy ? "работает" : "ждёт / запускается"}</span>}>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Монет BingX" value={`${e.ready} из ${e.universe}`} hint={e.backfillPending ? `догружается история: ${e.backfillPending}` : "история загружена"} />
        <Metric label="Последний цикл" value={ago === null ? "—" : `${ago} мин назад`} hint={e.lastCycleMs ? `${Math.round(e.lastCycleMs / 1000)} с` : ""} />
        <Metric label="Сделки" value={`${data.signals.open} откр.`} hint={`${data.signals.closed} закрыто`} />
        <Metric label="CoinGlass" value={`${data.coinglass.ok} ок`} hint={`${data.coinglass.failed} ошибок · ${data.coinglass.rateLimited} лимит`} />
      </div>
      {e.lastCycleRefreshFailed > 0 && <p className="mt-3 text-xs text-warn">В последнем цикле без свечей: {e.lastCycleRefreshFailed} монет (по ним сигналов не было).</p>}
      {cg?.lastError && cg.consecutiveFailures > 0 && <p className="mt-1 text-xs text-down">CoinGlass: {cg.lastError}</p>}
      {e.lastError && <p className="mt-1 text-xs text-down">Ошибка движка: {e.lastError}</p>}
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function StatsCard({ pin }: { pin: string }) {
  const [days, setDays] = useState(30);
  const { data } = usePoll<{ setups: StatRow[]; open: Array<{ setup: string; open: number }> }>(`/nh/stats?days=${days}`, pin);
  const openBy = new Map((data?.open ?? []).map((o) => [o.setup, o.open]));
  const setups = Object.keys(SETUP_LABEL);
  const byName = new Map((data?.setups ?? []).map((s) => [s.setup, s]));
  return (
    <Card title="Результат по сетапам" right={
      <div className="flex border border-border text-xs">
        {[7, 30, 3650].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={`whitespace-nowrap px-3 py-1 ${days === d ? "bg-accent text-background" : "text-muted"}`}>
            {d === 3650 ? "всё" : `${d} дн`}
          </button>
        ))}
      </div>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm tabular">
          <thead className="text-left text-[11px] uppercase text-muted">
            <tr><th className="py-2">Сетап</th><th>Сделок</th><th>Плюс</th><th>Тейк 1</th><th>Стоп</th><th>Сред. R</th><th>Сумма R</th><th>Сред. %</th><th>Откр.</th></tr>
          </thead>
          <tbody>
            {setups.map((name) => {
              const s = byName.get(name);
              return (
                <tr key={name} className="border-t border-border">
                  <td className="py-2">{SETUP_LABEL[name]}</td>
                  <td>{s?.trades ?? 0}</td>
                  <td>{s?.trades ? `${Math.round((s.wins / s.trades) * 100)}%` : "—"}</td>
                  <td>{s?.trades ? `${Math.round((s.tp1 / s.trades) * 100)}%` : "—"}</td>
                  <td>{s?.trades ? `${Math.round((s.stops / s.trades) * 100)}%` : "—"}</td>
                  <td className={tone(s?.avg_r)}>{num(s?.avg_r)}</td>
                  <td className={tone(s?.sum_r)}>{num(s?.sum_r)}</td>
                  <td className={tone(s?.avg_pnl_pct)}>{num(s?.avg_pnl_pct)}</td>
                  <td>{openBy.get(name) ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">R — результат в стопах: +2R значит заработано два размера стопа. Проценты — движение цены с учётом комиссий, без плеча.</p>
    </Card>
  );
}

function SignalsCard({ pin, status }: { pin: string; status: "open" | "closed" }) {
  const { data } = usePoll<{ signals: Signal[] }>(`/nh/signals?status=${status}&limit=50`, pin);
  const rows = data?.signals ?? [];
  return (
    <Card title={status === "open" ? "Открытые сделки" : "Последние закрытые"}>
      {!rows.length ? <p className="text-sm text-muted">{status === "open" ? "Пока нет." : "Ещё ничего не закрылось."}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm tabular">
            <thead className="text-left text-[11px] uppercase text-muted">
              <tr><th className="py-2">Монета</th><th>Сетап</th><th>Вход</th><th>Стоп</th><th>Тейк 1 / 2</th><th>Блок</th><th>{status === "open" ? "Открыта" : "Итог"}</th></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="py-2 font-semibold">{coin(s.symbol)} <span className={s.side === "long" ? "text-up" : "text-down"}>{s.side === "long" ? "лонг" : "шорт"}</span></td>
                  <td className="text-muted">{SETUP_LABEL[s.setup] ?? s.setup}</td>
                  <td>{price(s.entry)}</td>
                  <td>{price(s.stop)} <span className="text-muted">({num(s.risk_pct, 1)}%)</span></td>
                  <td>{price(s.tp1)}{s.tp1_hit ? " ✓" : ""} / {price(s.tp2)}{s.targets_source === "r_multiple" ? <span className="text-muted"> (2R/3R)</span> : null}</td>
                  <td className="text-muted">{price(s.block_bottom)}–{price(s.block_top)}</td>
                  <td>{status === "open" ? when(s.opened_at) : (
                    <span className={tone(s.pnl_pct)}>{CLOSE_LABEL[s.close_reason ?? ""] ?? s.close_reason} · {num(s.pnl_pct)}% · {num(s.r_multiple)}R</span>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DecisionsCard({ pin }: { pin: string }) {
  const { data } = usePoll<Decisions>("/nh/decisions?limit=1", pin, 60_000);
  const rows = data?.reasons7d ?? [];
  return (
    <Card title="Решения за 7 дней">
      {!rows.length ? <p className="text-sm text-muted">Пока нет.</p> : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.reason} className="flex justify-between gap-3 border-t border-border pt-1 first:border-t-0">
              <span>{REASON_LABEL[r.reason] ?? r.reason}</span><span className="tabular text-muted">{r.n}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function App() {
  const [pin, setPin] = useState(readPin);
  const [needPin, setNeedPin] = useState(false);
  useEffect(() => {
    get("/nh/status", pin).then(() => setNeedPin(false)).catch((e) => { if (e instanceof PinError) setNeedPin(true); });
  }, [pin]);
  if (needPin) {
    return <PinGate onPin={(p) => { try { localStorage.setItem(PIN_KEY, p); } catch { /* private mode */ } setPin(p); }} />;
  }
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 pb-16">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">Crypto Nihilist</h1>
        <p className="text-xs text-muted">Ордер-блок 4h/1D → слом структуры 30m/1h · фьючерсы BingX · сигналы пока только здесь</p>
      </header>
      <StatusCard pin={pin} />
      <StatsCard pin={pin} />
      <SignalsCard pin={pin} status="open" />
      <SignalsCard pin={pin} status="closed" />
      <DecisionsCard pin={pin} />
    </main>
  );
}
