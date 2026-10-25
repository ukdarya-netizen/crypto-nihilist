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
    leaseAcquired: boolean; startedAt: number;
  };
  coinglass: { started: number; ok: number; failed: number; rateLimited: number; keys: number; cooldownMs: number; minGapMs: number };
  health: Record<string, { lastError: string | null; lastErrorAt: number | null; lastSuccessAt: number | null; consecutiveFailures: number }>;
  signals: { open: number; closed: number };
  telegram?: { configured: boolean; channel: string | null };
};
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
  live: boolean; current_stop: number | null; trailing_active: boolean; breakeven_moved: boolean;
  peak_pct: number; last_milestone: number;
};
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
