import { useEffect, useState } from "react";

export const PIN_KEY = "nihilist-pin";
export class PinError extends Error {}

export function readPin(): string {
  try { return localStorage.getItem(PIN_KEY) ?? ""; } catch { return ""; }
}
export function savePin(pin: string): void {
  try { localStorage.setItem(PIN_KEY, pin); } catch { /* private mode: PIN lives for this tab only */ }
}

let currentPin = readPin();
export function setCurrentPin(pin: string): void { currentPin = pin; }

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: currentPin ? { "x-dashboard-pin": currentPin } : {} });
  if (res.status === 401) throw new PinError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

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
    configured: boolean; enabled?: boolean; channel: string | null;
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
  d_fut_taker_net_1h: "Фьюч. тейкер net 1ч, %", d_fut_taker_net_4h: "Фьюч. тейкер net 4ч, %", d_fut_taker_net_24h: "Фьюч. тейкер net 24ч, %",
  d_fut_vol24h_usd: "Объём фьючерсов 24ч, $", d_fut_vol4h_vs_avg: "Объём фьюч. 4ч к среднему, ×",
  d_spot_cvd_chg1h: "Spot CVD Δ1ч", d_spot_cvd_chg4h: "Spot CVD Δ4ч", d_spot_cvd_chg24h: "Spot CVD Δ24ч",
  d_spot_taker_net_1h: "Спот тейкер net 1ч, %", d_spot_taker_net_4h: "Спот тейкер net 4ч, %", d_spot_taker_net_24h: "Спот тейкер net 24ч, %",
  d_spot_vol24h: "Объём спота 24ч", d_fut_spot_ratio: "Фьючерсы / спот, ×",
  d_liq_long_1h: "Ликвидации лонгов 1ч, $", d_liq_short_1h: "Ликвидации шортов 1ч, $", d_liq_long_24h: "Ликвидации лонгов 24ч, $",
  d_liq_short_24h: "Ликвидации шортов 24ч, $", d_liq_long_ratio_1h_24h: "Ликв. лонгов 1ч / 24ч",
  d_ls_long_pct: "Binance: аккаунтов в лонге, %", d_ls_long_pct_chg: "Binance: Δ доли лонгов (5ч), п.п.", d_funding_pct: "Funding, %",
  trend_4h_aligned: "Тренд 4h (EMA50/200) по ходу", trend_1d_aligned: "Тренд 1D (EMA50/200) по ходу", btc_trend_4h_aligned: "Тренд BTC 4h по ходу",
};
export function metricLabel(key: string): string {
  const btc = key.startsWith("btc_");
  const k = btc ? key.slice(4) : key;
  let label = BASE_LABEL[k];
  if (!label) {
    if (k.startsWith("rsi_")) label = `RSI ${TF(k).slice(4)}`;
    else if (k.startsWith("atrpct_")) label = `ATR ${TF(k).slice(7)}, %`;
    else if (k.startsWith("ema50dist_")) label = `От EMA50 ${TF(k).slice(10)}, %`;
    else if (k.startsWith("ema200dist_")) label = `От EMA200 ${TF(k).slice(11)}, %`;
    else if (k.startsWith("trend_")) label = `Тренд ${TF(k).slice(6)} (EMA50/200)`;
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
