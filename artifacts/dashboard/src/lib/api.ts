import { useEffect, useState } from "react";

/** Session (accounts as in CAB, owner 2026-11-02). */
export const TOKEN_KEY = "nihilist-token";
export type Session = { token: string; name: string; email: string; role: "owner" | "user" };
export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}
/** Signed out, or access ended (pending / blocked / subscription expired). */
export class AuthError extends ApiError {}

export function readSession(): Session | null {
  try { const raw = localStorage.getItem(TOKEN_KEY); return raw ? JSON.parse(raw) as Session : null; } catch { return null; }
}
let session = readSession();
export function saveSession(s: Session | null): void {
  session = s;
  try { if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s)); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode: this tab only */ }
}
export const currentSession = () => session;
/** Owner sees everything; users see positions, overview, history and the rules (2026-11-02). */
export const isOwner = () => session?.role === "owner";

const authListeners = new Set<(e: AuthError) => void>();
export function onAuthError(fn: (e: AuthError) => void): () => void { authListeners.add(fn); return () => authListeners.delete(fn); }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
  if ((res.status === 401 || res.status === 403) && !path.startsWith("/auth/")) {
    const err = new AuthError(data.error ?? "Требуется вход", data.code);
    if (res.status === 401 || data.code) authListeners.forEach((fn) => fn(err));
    throw err;
  }
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.code ?? String(res.status));
  return data as T;
}

export const get = <T>(path: string) => request<T>("GET", path);
export const post = <T>(path: string, body: unknown) => request<T>("POST", path, body);
export const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const del = <T>(path: string) => request<T>("DELETE", path);

export function usePoll<T>(path: string, ms = 15_000): { data: T | null; error: Error | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      get<T>(path).then((d) => { if (alive) { setData(d); setError(null); } })
        .catch((e: Error) => { if (alive) setError(e); });
    };
    load();
    const timer = setInterval(load, ms);
    document.addEventListener("visibilitychange", load);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [path, ms]);
  return { data, error };
}

// ---------------- types ----------------
export type Status = {
  engine: {
    universe: number; ready: number; backfillPending: number; lastCycleAt: number | null; lastCycleMs: number | null;
    lastCycleRefreshFailed: number; lastCycleSignals: number; lastCycleDecisions: number; lastError: string | null;
    leaseAcquired: boolean; startedAt: number; phase?: string; loadedFromDb?: number;
    cycle?: CycleNow | null;
  };
  snapshotBackfill: {
    monitoringSince: number | null; lastStartedAt: number | null; lastSuccessfulAt: number | null;
    lastFailedAt: number | null; running: boolean; ageMs: number | null; staleAfterMs: number; overdue: boolean;
  };
  coinglass: { started: number; ok: number; failed: number; rateLimited: number; keys: number; cooldownMs: number; minGapMs: number };
  health: Record<string, { lastError: string | null; lastErrorAt: number | null; lastSuccessAt: number | null; consecutiveFailures: number }>;
  signals: { open: number; closed: number };
  telegram?: {
    configured: boolean; enabled?: boolean; channel: string | null; recipients?: number;
    deliveries?: { sent: number; pending: number; failed: number; skipped: number };
  };
};
export type CycleNow = { bar: number; startedAt: number; stage: "refresh" | "late_retry" | "evaluate"; done: number; total: number };
export type CycleRecord = {
  bar: number; startedAt: number; finishedAt: number; ms: number; checked: number; refreshFailed: number;
  lateRetries: number; candidates: number; signals: number; decisions: number; error: string | null;
};
export type Candidate = {
  symbol: string; setup: string; htf: string; ltf: string; side: "long" | "short"; blockId: string; blockTop: number; blockBottom: number;
  blockScope: string; firstTouchAt: number; lastTouchAt: number; extreme: number | null; lastClose: number;
  barsSinceTouch: number; updatedAt: number;
};
export type ScannerData = { current: CycleNow | null; cycles: CycleRecord[]; candidates: Candidate[] };
export const STAGE_LABEL: Record<CycleNow["stage"], string> = {
  refresh: "загрузка свечей", late_retry: "ждём запоздавшие свечи", evaluate: "поиск сетапов",
};
export const dur = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}м ${Math.round((ms % 60_000) / 1000)}с` : `${Math.round(ms / 1000)}с`);
export type StatRow = {
  setup: string; trades: number; wins: number; tp1: number; stops: number; timeouts: number;
  avg_r: number | null; sum_r: number | null; avg_pnl_pct: number | null;
};
export type DailyRow = { day: string; trades: number; wins: number; sum_r: number; sum_pnl_pct: number };
export type Signal = {
  id: number; symbol: string; setup: string; htf: string; ltf: string; side: "long" | "short";
  entry: number; stop: number; tp1: number; tp2: number; risk_pct: number; rr1: number;
  opened_at: string; expires_at: string; closed_at: string | null; close_reason: string | null;
  exit_price: number | null; pnl_pct: number | null; r_multiple: number | null; tp1_hit: boolean;
  mfe_pct: number; mae_pct: number; block_top: number; block_bottom: number; block_scope: string;
  targets_source: string; last_price: number | null;
  status: "open" | "closed"; live: boolean; current_stop: number | null; trailing_active: boolean; breakeven_moved: boolean;
  peak_pct: number; last_milestone: number;
  details?: Record<string, unknown>;
  snapshot?: Snapshot | null; close_context?: Snapshot | null;
  snapshot_reconstructed?: boolean | null; snapshot_status?: string | null;
};
export type Snapshot = Record<string, number | string | boolean | null>;
export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type Decision = {
  id: number; symbol: string; setup: string; bar_time: string; decision: string; reason: string | null;
  created_at: string; details: Record<string, unknown>;
};

// ---------------- labels & format ----------------
export const SETUPS = [
  "4h_30m_long", "4h_1h_long", "1d_30m_long", "1d_1h_long",
  "4h_30m_short", "4h_1h_short", "1d_30m_short", "1d_1h_short",
] as const;

export function setupLabel(setup: string): string {
  const [htf, ltf, side] = setup.split("_");
  return `ОБ ${htf === "1d" ? "1D" : htf} → слом ${ltf} · ${side === "long" ? "лонг" : "шорт"}`;
}
export const CLOSE_LABEL: Record<string, string> = {
  trailing: "трейлинг", breakeven: "безубыток", stop: "стоп", timeout: "время вышло",
};
export const REASON_LABEL: Record<string, string> = {
  rr_too_low: "первый тейк ближе 1R",
  risk_too_large: "стоп дальше 20%",
  stop_not_behind_entry: "стоп не за входом",
  open_signal_same_setup: "уже есть открытая сделка этого сетапа",
  ob_too_weak: "слабый ордер-блок",
  open_signal_same_symbol: "по монете уже открыта сделка",
  duplicate_same_move: "тот же вход другим сетапом (засчитан в основной)",
  accepted: "сигнал",
  rejected: "отказ",
  skipped: "пропуск",
};

const FILTER_LABEL: Record<string, string> = {
  risk_below_7pct: "стоп ближе 7%", block_older_300h: "блок старше 300 ч", block_age_unknown: "возраст блока неизвестен",
  block_below_4pct: "блок ниже 4% цены",
};
/** Reason of a decision in Russian (entry filter reasons: «фильтр лонгов: …»). */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "—";
  if (reason.startsWith("entry_filter:")) return `фильтр лонгов: ${FILTER_LABEL[reason.slice(13)] ?? reason.slice(13)}`;
  return REASON_LABEL[reason] ?? reason;
}

export const num = (v: number | null | undefined, d = 2) =>
  (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(d));
export const signed = (v: number | null | undefined, d = 2, suffix = "") =>
  (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(d)}${suffix}`);
export const price = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4);
};
export const tone = (v: number | null | undefined) =>
  (v === null || v === undefined ? "" : Number(v) > 0 ? "text-up" : Number(v) < 0 ? "text-down" : "");
export const when = (iso: string | number | null) =>
  (iso === null ? "—" : new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
export const coin = (symbol: string) => symbol.replace(/-USDT$/, "");

/** No take profit (owner 2026-11-02): trades since then are managed by break-even and trailing only. */
export const hasTp1 = (s: { targets_source?: string | null }) => s.targets_source !== "trailing_only";

/** Live result of an open trade in % (no fees), from the last closed 30m price. */
/** Price move of an open trade from entry, % in the trade direction (as in AltBullet). */
export function livePct(s: Signal): number | null {
  if (s.last_price === null || s.last_price === undefined) return null;
  const dir = s.side === "long" ? 1 : -1;
  return ((Number(s.last_price) - s.entry) / s.entry) * 100 * dir;
}

/** Human labels of snapshot metrics (engine/metrics.ts). */
const TF = (k: string) => k.replace("_30m", " 30m").replace("_1h", " 1h").replace("_4h", " 4h").replace("_1d", " 1D");
const BASE_LABEL: Record<string, string> = {
  side: "Направление", htf: "ТФ блока", ltf: "ТФ слома", block_scope: "Тип блока", targets_source: "Тейк 1 из",
  risk_pct: "Стоп, %", rr1: "R до тейка 1", tp1_pct: "Тейк 1, %", block_size_pct: "Размер блока, %",
  entry_from_block_pct: "Вход от края блока, %", block_age_h: "Возраст блока, ч", since_first_touch_h: "С первого касания, ч",
  since_last_touch_h: "С последнего касания, ч", touch_span_h: "Касания длились, ч", ltf_atr_pct: "ATR младшего ТФ, %",
  htf_swing_aligned: "Swing-тренд старшего ТФ по ходу", htf_internal_aligned: "Internal-тренд старшего ТФ по ходу",
  hour_utc: "Час сигнала (UTC)", weekday_utc: "День недели (0 = вс)", price: "Цена",
  chg1h: "Изм. 1ч, %", chg4h: "Изм. 4ч, %", chg24h: "Изм. 24ч, %", chg7d: "Изм. 7д, %", chg30d: "Изм. 30д, %",
  range24h_pos: "Позиция в диапазоне 24ч (0–100)", range7d_pos: "Позиция в диапазоне 7д (0–100)", range30d_pos: "Позиция в диапазоне 30д (0–100)",
  confluence: "Сетапов на одном движении",
  ob_displacement_atr: "Сила ОБ: слом за блоком, ATR", ob_break_bars: "Свечей от ОБ до слома", ob_height_atr: "Высота ОБ, ATR",
  ob_penetration_pct: "Глубина захода в ОБ, %",
  d_oi_usd: "OI, $", d_oi_chg1h: "OI Δ1ч, %", d_oi_chg4h: "OI Δ4ч, %", d_oi_chg24h: "OI Δ24ч, %",
  d_ls_long_pct: "Binance: аккаунтов в лонге, %", d_ls_long_pct_chg: "Binance: Δ доли лонгов (5ч), п.п.",
  vsa_choch_vol_rel: "VSA ТФ слома (только BingX): объём свечи слома / средний 20", vsa_ext_vol_rel: "VSA ТФ слома (только BingX): объём свечи экстремума / средний 20",
  vsa_ext_close_pos: "VSA ТФ слома (только BingX): закрытие свечи экстремума (1 = против хода вниз, выкуп)", vsa_ext_spread_atr: "VSA ТФ слома (только BingX): размах свечи экстремума, ATR",
  vsa_max_vol_rel: "VSA ТФ слома (только BingX): макс. объём от касания до слома / средний 20", vsa_test_low_vol: "VSA ТФ слома (только BingX): тест экстремума на низком объёме",
  vsa_vol_trend: "VSA ТФ слома (только BingX): объём 5 свечей до слома / средний 20", vsa_no_supply_bars: "VSA ТФ слома (только BingX): свечей «нет предложения»",
  vsa_window_bars: "VSA ТФ слома (только BingX): свечей от касания до слома",
  choch_range_atr: "Свеча слома: размах, ATR", choch_body_atr: "Свеча слома: тело, ATR", choch_range_pct: "Свеча слома: размах, %",
  choch_body_pct: "Свеча слома: тело, %", choch_close_pos: "Свеча слома: закрытие (0–1)",
  trend_4h_aligned: "Тренд 4h (EMA50/200) по ходу", trend_1d_aligned: "Тренд 1D (EMA50/200) по ходу", btc_trend_4h_aligned: "Тренд BTC 4h по ходу",
};
const UNCOLLECTED_METRIC_PREFIXES = [
  "d_fut_taker_net_", "d_spot_taker_net_", "d_spot_cvd_chg", "d_liq_", "d_fut_vol",
];
const UNCOLLECTED_METRIC_KEYS = new Set(["d_funding_pct", "d_spot_vol24h", "d_fut_spot_ratio", "vsa_checked", "flow_v", "flow_post_v", "flow_empty", "dlt_tf"]);

/** Volume / OI / delta keys (owner 2026-11-03), in plain Russian. */
const FLOW_PART: Record<string, string> = {
  choch_vol_rel: "объём последнего бара / ср.20", ext_vol_rel: "объём бара-экстремума / ср.20", ext_close_pos: "закрытие бара-экстремума (1 = по ходу)",
  ext_spread_atr: "размах бара-экстремума, ATR", max_vol_rel: "макс. всплеск объёма от касания", test_low_vol: "тест на низком объёме",
  vol_trend: "тренд объёма (5 баров / ср.20)", no_supply_bars: "бары «нет предложения»", window_bars: "баров от касания",
};
export function flowLabel(k: string): string | null {
  let m: RegExpMatchArray | null;
  const tf = (x: string) => x.replace("1d", "1D");
  if ((m = k.match(/^vsa(30m|1h|4h|1d)_(.+)$/))) return `VSA ${tf(m[1]!)}: ${FLOW_PART[m[2]!] ?? m[2]}`;
  if ((m = k.match(/^vol_src_(30m|1h|4h|1d)$/))) return `Источник объёма ${tf(m[1]!)} (aggregated = все биржи, bingx = только BingX)`;
  if ((m = k.match(/^app(30m|1h|4h)_(.+)$/))) return `Подход к блоку ${m[1]}: ${{ vol_trend: "тренд объёма", spread_atr: "размах баров, ATR", press_bars: "бары давления (объём+размах к блоку)", move10: "ход цены за 10 баров" }[m[2]!] ?? m[2]}`;
  if ((m = k.match(/^oi(15m|30m|1h|4h|1d)_chg(1|4|_touch)$/))) return `OI ${tf(m[1]!)}: изменение ${m[2] === "_touch" ? "от касания до сигнала" : m[2] === "1" ? "за 1 бар" : "за 4 бара"}, %`;
  if ((m = k.match(/^oi_quad_(break|touch)_(15m|30m|1h)$/))) return `Цена × OI ${m[2]} ${m[1] === "break" ? "на баре слома" : "от касания"}`;
  if ((m = k.match(/^(post1h|post2h|post4h)_(.+)$/))) return `После входа +${m[1]!.slice(4)}: ${{ vol_rel: "объём / ср.20 до входа", against_share: "доля объёма против сделки", max_against_vol_rel: "макс. бар против / ср.20", move: "ход цены, %", oi_since_entry: "OI с входа, %", dlt_fut_since_entry: "дельта фьючерсов с входа", dlt_spot_since_entry: "дельта спота с входа" }[m[2]!] ?? m[2]}`;
  const fixed: Record<string, string> = {
    ob_vol_rel: "Объём свечи ордер-блока / ср.20", ob_vol_rank: "Объём свечи блока: перцентиль за 100 баров", ob_next_vol_rel: "Объём свечи после блока / ср.20",
    ob_spread_atr: "Размах свечи блока, ATR", dlt_fut_touch_net: "Дельта фьючерсов от касания (по ходу), %", dlt_spot_touch_net: "Дельта спота от касания (по ходу), %",
    dlt_spot_minus_fut_touch: "Спот минус фьючерсы от касания", dlt_div_fut: "Цена × дельта фьючерсов после касания", dlt_div_spot: "Цена × дельта спота после касания",
    dlt_fut_break_net: "Дельта фьючерсов на баре слома", dlt_spot_break_net: "Дельта спота на баре слома", dlt_fut_4h_net: "Дельта фьючерсов за 4ч", dlt_spot_4h_net: "Дельта спота за 4ч",
  };
  return fixed[k] ?? null;
}
export function isUncollectedMetric(key: string): boolean {
  return UNCOLLECTED_METRIC_KEYS.has(key) || UNCOLLECTED_METRIC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function metricLabel(key: string): string {
  const btc = key.startsWith("btc_");
  const k = btc ? key.slice(4) : key;
  let label = BASE_LABEL[k] ?? flowLabel(k) ?? undefined;
  if (!label) {
    if (k.startsWith("rsi_")) label = `RSI ${TF(k).slice(4)}`;
    else if (k.startsWith("atrpct_")) label = `ATR ${TF(k).slice(7)}, %`;
    else if (k.startsWith("ema50dist_")) label = `От EMA50 ${TF(k).slice(10)}, %`;
    else if (k.startsWith("ema200dist_")) label = `От EMA200 ${TF(k).slice(11)}, %`;
    else if (k.startsWith("trend_")) label = `Тренд ${TF(k).slice(6)} (EMA50/200)`;
    else if (k.startsWith("adx_")) label = `ADX ${TF(k).slice(4)}`;
    else if (k.startsWith("di_diff_")) label = `+DI − −DI ${TF(k).slice(8)} по ходу`;
    else label = key;
  }
  return btc ? `BTC · ${label}` : label;
}
export function metricValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (v === "up") return "вверх";
  if (v === "down") return "вниз";
  if (typeof v === "number") return compact(v);
  return String(v);
}
export const fmtHours = (h: number | null | undefined) =>
  h === null || h === undefined ? "—" : h >= 24 ? `${Math.floor(h / 24)}д ${Math.round(h % 24)}ч` : `${h.toFixed(1)}ч`;

/** 1234567 → 1.23M; small numbers keep 2–4 significant decimals. */
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return v.toFixed(0);
  return String(Number(v.toFixed(a >= 1 ? 2 : 4)));
}
