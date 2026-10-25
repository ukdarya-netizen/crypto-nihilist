/**
 * External API health: failures are counted and visible on the dashboard and
 * in the server log. No Telegram messages (owner rule: only signals go out).
 */
export type ApiName = "coinglass";

type State = {
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
};

const states = new Map<ApiName, State>();
const state = (api: ApiName): State => {
  let s = states.get(api);
  if (!s) {
    s = { lastError: null, lastErrorAt: null, lastSuccessAt: null, consecutiveFailures: 0 };
    states.set(api, s);
  }
  return s;
};

export function recordSuccess(api: ApiName, now = Date.now()): void {
  const s = state(api);
  s.lastSuccessAt = now;
  s.consecutiveFailures = 0;
}

export function recordFailure(api: ApiName, message: string, now = Date.now()): void {
  const s = state(api);
  s.lastError = message.slice(0, 300);
  s.lastErrorAt = now;
  s.consecutiveFailures += 1;
}

export function apiHealth(): Record<string, State> {
  return Object.fromEntries([...states.entries()].map(([k, v]) => [k, { ...v }]));
}
