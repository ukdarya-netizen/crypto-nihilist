/**
 * Research (owner 2026-10-29): Elliott "entry into wave 3" setup on history.
 * Candles only (public BingX klines), crypto only, no database, no live code.
 *
 * Rules (long; short is the exact mirror on inverted prices):
 *  - Pivots: fractal highs/lows with L bars on each side. A pivot is KNOWN only
 *    L bars after it (no look-ahead). Consecutive pivots of one type keep the
 *    extreme one.
 *  - Wave 1: pivot low P0 -> pivot high P1, P1 above the last pivot high before
 *    P0 (breaks structure), size P1-P0 >= 3 x ATR(14) at P1.
 *  - Wave 2: the next pivot low P2 after P1, P2 > P0, retrace
 *    (P1-P2)/(P1-P0) in [0.5, 0.786].
 *  - Entry: after P2 is known, the first CLOSE above P1, within W bars
 *    (W = 2 x wave-1 length in bars, max 120). Any close below P2 first
 *    cancels the setup. Entry at that close.
 *  - Stop: P2 (and the Nihilist variant P2 -3%). Risk must be > 0.3%.
 *  - Exits compared (stop first inside a bar, fee 0.1%, horizon H bars):
 *      tgt   target P2 + 1.618 x (P1-P0), else close at H
 *      r     B.U. at +1R, then trail 1R below the peak
 *      ab    AltBullet: B.U. at +5%, trail 10 pp below the peak from +15%
 *  - One open trade per symbol and side.
 *
 * Output per timeframe / L / side / stop / exit: n, sum, avg %, avg R, win %,
 * by month, thirds of the period, symbols. Per-trade CSV for further fitting.
 *
 * Run (from scripts/): npx tsx src/elliott-wave3-backtest.ts --tf 1h --days 100 --out /tmp/ew3_1h
 *   --tf 1h|4h  --days N  --L 3,5,8  --limit N (symbols, for a quick check)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const TF = (args.get("tf") ?? "1h") as "1h" | "4h";
const DAYS = Number(args.get("days") ?? 100);
const OUT = args.get("out") ?? `/tmp/ew3_${TF}`;
const LS = (args.get("L") ?? "3,5,8").split(",").map(Number);
const LIMIT = Number(args.get("limit") ?? 10_000);
const BAR = TF === "1h" ? 3_600_000 : 4 * 3_600_000;
const H = TF === "1h" ? 72 : 30; // 72h on 1H, 5 days on 4H
const FEE = 0.1;
const HOST = "https://open-api.bingx.com";

type C = { time: number; open: number; high: number; low: number; close: number };

async function getJson(path: string): Promise<any> {
  for (let a = 0; a < 4; a++) {
    try {
      const j = (await (await fetch(HOST + path)).json()) as { code: number; data?: unknown };
      if (j.code === 0) return j.data;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800 * (a + 1)));
  }
  throw new Error(`request failed: ${path}`);
}

async function klines(symbol: string, start: number, end: number): Promise<C[]> {
  const out = new Map<number, C>();
  for (let cur = start; cur < end; cur += BAR * 1000) {
    const d = (await getJson(`/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${TF}&startTime=${cur}&endTime=${Math.min(end, cur + BAR * 1000)}&limit=1000`)) as Array<Record<string, string>>;
    for (const k of d ?? []) out.set(Number(k.time), { time: Number(k.time), open: +k.open, high: +k.high, low: +k.low, close: +k.close });
  }
  return [...out.values()].filter((c) => c.time + BAR <= end).sort((a, b) => a.time - b.time);
}

/** Crypto only: no stock / commodity / index / FX contracts. */
function isCrypto(symbol: string): boolean {
  const base = symbol.replace(/-USDT$/, "");
  return !/^(NCSK|NCCO|NCSI|NCFX)/.test(base) && !base.includes("USD");
}

const mirror = (cs: C[]): C[] => cs.map((c) => ({ time: c.time, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close }));

function atr14(cs: C[], i: number): number | null {
  if (i < 15) return null;
  let s = 0;
  for (let k = i - 13; k <= i; k++) s += Math.max(cs[k]!.high - cs[k]!.low, Math.abs(cs[k]!.high - cs[k - 1]!.close), Math.abs(cs[k]!.low - cs[k - 1]!.close));
  return s / 14;
}

type Pv = { i: number; price: number; type: "H" | "L"; knownAt: number };
export function pivots(cs: C[], L: number): Pv[] {
  const raw: Pv[] = [];
  for (let i = L; i < cs.length - L; i++) {
    let isH = true, isL = true;
    for (let k = i - L; k <= i + L; k++) {
      if (k === i) continue;
      if (cs[k]!.high >= cs[i]!.high) isH = false;
      if (cs[k]!.low <= cs[i]!.low) isL = false;
    }
    if (isH) raw.push({ i, price: cs[i]!.high, type: "H", knownAt: i + L });
    if (isL) raw.push({ i, price: cs[i]!.low, type: "L", knownAt: i + L });
  }
  // Alternate: keep the extreme of consecutive same-type pivots. The merged
  // pivot is known when the later one is known (never earlier).
  const out: Pv[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) {
      const better = p.type === "H" ? p.price > last.price : p.price < last.price;
      out[out.length - 1] = better ? { ...p } : { ...last, knownAt: Math.max(last.knownAt, p.knownAt) };
    } else out.push({ ...p });
  }
  return out;
}

type Exit = "tgt" | "r" | "ab";
/** Long result in % of entry on (possibly mirrored) candles; short % computed exactly by the caller. */
export function simulate(cs: C[], j: number, entry: number, stop0: number, target: number, mode: Exit): { exit: number; bars: number } | null {
  const after = cs.slice(j + 1, j + 1 + H);
  if (after.length < H) return null;
  const risk = entry - stop0;
  let stop = stop0, peak = entry;
  for (let k = 0; k < after.length; k++) {
    const c = after[k]!;
    if (c.low <= stop) return { exit: stop, bars: k + 1 };
    if (mode === "tgt" && c.high >= target) return { exit: target, bars: k + 1 };
    peak = Math.max(peak, c.high);
    if (mode === "r" && peak >= entry + risk) stop = Math.max(stop, entry, peak - risk);
    if (mode === "ab") {
      const pp = (peak / entry - 1) * 100;
      if (pp >= 5) stop = Math.max(stop, entry);
      if (pp >= 15) stop = Math.max(stop, entry * (1 + (pp - 10) / 100));
    }
  }
  return { exit: after[after.length - 1]!.close, bars: after.length };
}

type Trade = { tf: string; L: number; side: "long" | "short"; stop: "p2" | "p2_3pct"; exit: Exit; symbol: string; t: number; pnl: number; rMult: number; riskPct: number; retr: number; w1Pct: number; bars: number };

export function findSetups(cs: C[], L: number, from: number) {
  const pv = pivots(cs, L);
  const setups: { j: number; entry: number; p0: number; p1: number; p2: number; retr: number }[] = [];
  for (let a = 1; a + 2 < pv.length; a++) {
    const p0 = pv[a]!, p1 = pv[a + 1]!, p2 = pv[a + 2]!;
    if (p0.type !== "L" || p1.type !== "H" || p2.type !== "L") continue;
    const prevH = pv[a - 1]!; // pivot high before P0
    if (prevH.type !== "H" || !(p1.price > prevH.price)) continue;
    const at = atr14(cs, p1.i);
    if (at === null || !(p1.price - p0.price >= 3 * at)) continue;
    if (!(p2.price > p0.price)) continue;
    const retr = (p1.price - p2.price) / (p1.price - p0.price);
    if (retr < 0.5 || retr > 0.786) continue;
    const start = p2.knownAt; // first bar at whose close P2 is known
    const W = Math.min(120, 2 * (p1.i - p0.i));
    for (let j = start; j < Math.min(cs.length, start + W); j++) {
      const c = cs[j]!;
      if (c.close < p2.price) break; // structure lost before the break
      if (c.close > p1.price) {
        if (c.time >= from) setups.push({ j, entry: c.close, p0: p0.price, p1: p1.price, p2: p2.price, retr });
        break;
      }
    }
  }
  return setups;
}

async function main() {
  const now = Date.now(), from = now - DAYS * 86_400_000;
  const contracts = (await getJson("/openApi/swap/v2/quote/contracts")) as { symbol: string }[];
  const symbols = contracts.map((c) => c.symbol).filter((s) => s.endsWith("-USDT") && isCrypto(s)).slice(0, LIMIT);
  mkdirSync(OUT, { recursive: true });
  const trades: Trade[] = [];
  const errors: Record<string, string> = {};
  let done = 0;
  for (const symbol of symbols) {
    try {
      const raw = await klines(symbol, from - 300 * BAR, now);
      if (raw.length < 300) { errors[symbol] = "short_history"; continue; }
      for (const side of ["long", "short"] as const) {
        const cs = side === "long" ? raw : mirror(raw);
        for (const L of LS) {
          const setups = findSetups(cs, L, from);
          for (const stopKind of ["p2", "p2_3pct"] as const) {
            for (const mode of ["tgt", "r", "ab"] as Exit[]) {
              let busyUntil = -1;
              for (const s of setups) {
                if (s.j <= busyUntil) continue;
                const stop0 = stopKind === "p2" ? s.p2 : s.p2 * 0.97;
                const riskPct = (s.entry - stop0) / s.entry * 100;
                if (!(riskPct > 0.3)) continue;
                const target = s.p2 + 1.618 * (s.p1 - s.p0);
                const r = simulate(cs, s.j, s.entry, stop0, target, mode);
                if (!r) continue;
                // Exact % on real prices: mirrored price x = 1/real.
                const pnl = side === "long" ? (r.exit / s.entry - 1) * 100 - FEE : (1 - s.entry / r.exit) * 100 - FEE;
                const riskReal = side === "long" ? riskPct : (1 - s.entry / stop0) * -100;
                trades.push({ tf: TF, L, side, stop: stopKind, exit: mode, symbol, t: cs[s.j]!.time, pnl, rMult: pnl / Math.abs(riskReal), riskPct: Math.abs(riskReal), retr: s.retr, w1Pct: (s.p1 / s.p0 - 1) * 100, bars: r.bars });
                busyUntil = s.j + r.bars;
              }
            }
          }
        }
      }
    } catch (e) { errors[symbol] = String(e).slice(0, 80); }
    if (++done % 50 === 0) console.error(`${done}/${symbols.length} symbols, ${trades.length} trade rows`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const lines: string[] = [`period ${new Date(from).toISOString()}..${new Date(now).toISOString()} tf=${TF} horizon=${H} bars symbols=${symbols.length} errors=${Object.keys(errors).length}`];
  const keyOf = (t: Trade) => `${t.tf} L=${t.L} ${t.side} stop=${t.stop} exit=${t.exit}`;
  const groups = new Map<string, Trade[]>();
  for (const t of trades) groups.set(keyOf(t), [...(groups.get(keyOf(t)) ?? []), t]);
  for (const [k, xs] of [...groups.entries()].sort()) {
    xs.sort((a, b) => a.t - b.t);
    const n = xs.length, sum = xs.reduce((a, t) => a + t.pnl, 0);
    const thirds = [0, 1, 2].map((q) => xs.slice(Math.floor(q * n / 3), Math.floor((q + 1) * n / 3)).reduce((a, t) => a + t.pnl, 0).toFixed(0)).join("/");
    const months = [...new Set(xs.map((t) => new Date(t.t).toISOString().slice(0, 7)))].sort()
      .map((m) => { const ys = xs.filter((t) => new Date(t.t).toISOString().startsWith(m)); return `${m.slice(5)} ${(ys.reduce((a, t) => a + t.pnl, 0) / ys.length).toFixed(2)}% (${ys.length})`; }).join(" | ");
    lines.push(`${k.padEnd(40)} n=${String(n).padStart(4)} sum=${sum.toFixed(0)}% avg=${(sum / n).toFixed(2)}% avgR=${(xs.reduce((a, t) => a + t.rMult, 0) / n).toFixed(2)} win=${Math.round(100 * xs.filter((t) => t.pnl > 0).length / n)}% thirds=${thirds} symbols=${new Set(xs.map((t) => t.symbol)).size} | ${months}`);
  }
  writeFileSync(join(OUT, "summary.txt"), lines.join("\n"));
  writeFileSync(join(OUT, "trades.csv"), ["tf,L,side,stop,exit,symbol,entry_time,pnl_pct,r_mult,risk_pct,retrace,wave1_pct,bars",
    ...trades.map((t) => [t.tf, t.L, t.side, t.stop, t.exit, t.symbol, new Date(t.t).toISOString(), t.pnl.toFixed(3), t.rMult.toFixed(3), t.riskPct.toFixed(3), t.retr.toFixed(3), t.w1Pct.toFixed(2), t.bars].join(","))].join("\n"));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(lines.join("\n"));
}

if (process.argv[1]?.includes("elliott-wave3-backtest")) main().catch((e) => { console.error(e); process.exit(1); });
