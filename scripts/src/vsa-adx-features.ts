/**
 * Research (owner 2026-11-02): VSA, size of the structure-break (CHoCH) candle
 * and ADX for every Nihilist signal, computed from public BingX klines (with
 * volume) on bars CLOSED by the signal. No database, no live code.
 *
 * Input: src/data/nh-signals-vsa-input.json (id, symbol, side, ltf, barTime =
 * open time of the CHoCH bar, firstTouchAt, extreme, chochLevel, entry).
 * Output CSV (one row per signal), all values in the trade's direction
 * (shorts mirrored):
 *  CHoCH bar: range/ATR14, body/ATR14, close position 0..1, volume / avg20
 *  VSA between the first block touch and the CHoCH bar (LTF):
 *    ext_vol_rel      volume of the bar that made the extreme / avg20
 *    ext_close_pos    where that bar closed (long: 1 = at the high, i.e. buying into the low)
 *    ext_spread_atr   its range / ATR
 *    max_vol_rel      highest volume / avg20 in the window
 *    test_low_vol     1 when, after the extreme, a bar came within 0.5 ATR of it on volume < 0.7 x avg20 (VSA test)
 *    vol_trend        avg volume of the 5 bars before CHoCH / avg20 before them
 *    no_supply_bars   down bars (long) with spread < 0.7 ATR and volume < avg20 in the window
 *  ADX(14) with +DI / -DI on the LTF, 4h and 1d; di_diff in the trade direction.
 *
 * Run (from scripts/): npx tsx src/vsa-adx-features.ts > /tmp/vsa_adx.csv
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type Sig = { id: number; symbol: string; side: "long" | "short"; ltf: "30m" | "1h"; htf: string; barTime: number; firstTouchAt: number | null; extreme: number | null; chochLevel: number | null; entry: number };
type C = { t: number; o: number; h: number; l: number; c: number; v: number };

const here = dirname(fileURLToPath(import.meta.url));
const SIGS: Sig[] = JSON.parse(readFileSync(join(here, "data/nh-signals-vsa-input.json"), "utf8"));
const MS: Record<string, number> = { "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

async function klines(symbol: string, interval: string, end: number, bars: number): Promise<C[]> {
  const out = new Map<number, C>();
  const span = MS[interval]!;
  let to = end;
  for (let left = bars; left > 0;) {
    const n = Math.min(1000, left);
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&endTime=${to}&limit=${n}`;
    let j: { code: number; data?: Array<Record<string, string>> } | null = null;
    for (let a = 0; a < 3 && !j; a++) {
      try { const r = (await (await fetch(url)).json()) as typeof j; if (r && r.code === 0) j = r; } catch { /* retry */ }
      if (!j) await new Promise((r) => setTimeout(r, 800));
    }
    if (!j?.data?.length) break;
    for (const k of j.data) out.set(Number(k.time), { t: Number(k.time), o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume });
    const oldest = Math.min(...j.data.map((k) => Number(k.time)));
    left -= j.data.length;
    to = oldest - 1;
    if (j.data.length < n) break;
  }
  // Only bars closed by `end`.
  return [...out.values()].filter((c) => c.t + span <= end).sort((a, b) => a.t - b.t);
}

export const mirror = (cs: C[]): C[] => cs.map((c) => ({ t: c.t, o: -c.o, h: -c.l, l: -c.h, c: -c.c, v: c.v }));

function atrAt(cs: C[], i: number, n = 14): number | null {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(cs[k]!.h - cs[k]!.l, Math.abs(cs[k]!.h - cs[k - 1]!.c), Math.abs(cs[k]!.l - cs[k - 1]!.c));
  return s / n;
}
const avgVol = (cs: C[], end: number, n = 20) => { const p = cs.slice(Math.max(0, end - n), end); return p.length ? p.reduce((a, c) => a + c.v, 0) / p.length : null; };

/** Wilder ADX(14) at the last bar; +DI/-DI. */
export function adx(cs: C[], n = 14): { adx: number | null; pdi: number | null; mdi: number | null } {
  if (cs.length < n * 3) return { adx: null, pdi: null, mdi: null };
  let tr = 0, pdm = 0, mdm = 0; const dxs: number[] = [];
  let adxV: number | null = null;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!, p = cs[i - 1]!;
    const up = c.h - p.h, dn = p.l - c.l;
    const t = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    const pd = up > dn && up > 0 ? up : 0, md = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pdm += pd; mdm += md; if (i < n) continue; }
    else { tr = tr - tr / n + t; pdm = pdm - pdm / n + pd; mdm = mdm - mdm / n + md; }
    const pdi = tr ? (100 * pdm) / tr : 0, mdi = tr ? (100 * mdm) / tr : 0;
    const dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    dxs.push(dx);
    if (dxs.length === n) adxV = dxs.reduce((a, b) => a + b, 0) / n;
    else if (dxs.length > n && adxV !== null) adxV = (adxV * (n - 1) + dx) / n;
    if (i === cs.length - 1) return { adx: adxV, pdi, mdi };
  }
  return { adx: null, pdi: null, mdi: null };
}

const r3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "" : (Math.round(x * 1000) / 1000).toString());

async function main() {
  const cols = ["id", "symbol", "side", "ltf", "choch_range_atr", "choch_body_atr", "choch_close_pos", "choch_vol_rel",
    "ext_vol_rel", "ext_close_pos", "ext_spread_atr", "max_vol_rel", "test_low_vol", "vol_trend", "no_supply_bars", "window_bars",
    "adx_ltf", "di_diff_ltf", "adx_4h", "di_diff_4h", "adx_1d", "di_diff_1d", "error"];
  console.log(cols.join(","));
  for (const s of SIGS) {
    const row: Record<string, string> = { id: String(s.id), symbol: s.symbol, side: s.side, ltf: s.ltf, error: "" };
    try {
      const span = MS[s.ltf]!;
      const closeAt = s.barTime + span;
      const startWin = s.firstTouchAt ?? s.barTime - 48 * span;
      const barsBack = Math.min(1400, Math.ceil((closeAt - startWin) / span) + 80);
      let cs = await klines(s.symbol, s.ltf, closeAt, barsBack);
      if (s.side === "short") cs = mirror(cs);
      const k = cs.findIndex((c) => c.t === s.barTime);
      if (k < 25) throw new Error("choch_bar_not_found");
      const bar = cs[k]!, a = atrAt(cs, k), av = avgVol(cs, k);
      if (a && av) {
        row.choch_range_atr = r3((bar.h - bar.l) / a);
        row.choch_body_atr = r3((bar.c - bar.o) / a);
        row.choch_close_pos = r3(bar.h > bar.l ? (bar.c - bar.l) / (bar.h - bar.l) : null);
        row.choch_vol_rel = r3(bar.v / av);
      }
      // VSA window: from the first touch of the block up to the bar before the CHoCH.
      const w0 = Math.max(20, cs.findIndex((c) => c.t >= startWin));
      const win = cs.slice(w0, k);
      row.window_bars = String(win.length);
      if (win.length >= 2) {
        let ei = w0; for (let i = w0; i < k; i++) if (cs[i]!.l < cs[ei]!.l) ei = i;
        const e = cs[ei]!, ae = atrAt(cs, ei), ave = avgVol(cs, ei);
        if (ae && ave) {
          row.ext_vol_rel = r3(e.v / ave);
          row.ext_close_pos = r3(e.h > e.l ? (e.c - e.l) / (e.h - e.l) : null);
          row.ext_spread_atr = r3((e.h - e.l) / ae);
          let test = 0;
          for (let i = ei + 1; i < k; i++) {
            const c = cs[i]!, avi = avgVol(cs, i);
            if (avi && c.l <= e.l + 0.5 * ae && c.v < 0.7 * avi) { test = 1; break; }
          }
          row.test_low_vol = String(test);
        }
        let maxRel = 0, ns = 0;
        for (let i = w0; i < k; i++) {
          const c = cs[i]!, avi = avgVol(cs, i), ai = atrAt(cs, i);
          if (avi) maxRel = Math.max(maxRel, c.v / avi);
          if (avi && ai && c.c < c.o && c.h - c.l < 0.7 * ai && c.v < avi) ns++;
        }
        row.max_vol_rel = r3(maxRel);
        row.no_supply_bars = String(ns);
      }
      const v5 = cs.slice(k - 5, k).reduce((x, c) => x + c.v, 0) / 5, v20 = avgVol(cs, k - 5);
      row.vol_trend = r3(v20 ? v5 / v20 : null);
      const dir = 1; // candles already mirrored for shorts: +DI is the trade direction
      const l = adx(cs.slice(0, k + 1));
      row.adx_ltf = r3(l.adx); row.di_diff_ltf = r3(l.pdi !== null && l.mdi !== null ? dir * (l.pdi - l.mdi) : null);
      for (const tf of ["4h", "1d"] as const) {
        let h = await klines(s.symbol, tf, closeAt, 120);
        if (s.side === "short") h = mirror(h);
        const x = adx(h);
        row[`adx_${tf}`] = r3(x.adx); row[`di_diff_${tf}`] = r3(x.pdi !== null && x.mdi !== null ? x.pdi - x.mdi : null);
      }
    } catch (e) { row.error = String(e).slice(0, 40).replace(/,/g, ";"); }
    console.log(cols.map((c) => row[c] ?? "").join(","));
    await new Promise((r) => setTimeout(r, 120));
  }
}

if (process.argv[1]?.includes("vsa-adx-features")) main().catch((e) => { console.error(e); process.exit(1); });
