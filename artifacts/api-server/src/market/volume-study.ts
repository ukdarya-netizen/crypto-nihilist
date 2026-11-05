/**
 * Volume study at the entry (owner 2026-11-05): the same readings as in CAB, on Nihilist's own trades,
 * so they can be analysed by name.
 *  - Wyckoff phase over the 48 hourly bars before the entry (CAB rules, unchanged);
 *  - the owner's «VSA Wyckoff Volume» and «Welkin VSA» colours of those 48 bars, with each bar's
 *    candle and close position (VSA with candles: stopping volume, weakness, strength).
 * Entry candle = the last closed 1H candle before the signal. BingX klines (price + volume).
 * Shorts are read on mirrored candles (accumulation ↔ distribution). Stored in
 * nh_signals.details.volumeStudy (no new table). Observation only — no decision reads it.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { bingxKlines, mirror, type C } from "./vsa";
import { computeWyckoff } from "./wyckoff";
import { colorWindow } from "./volume-colors";

const H1 = 3_600_000;
const HISTORY_BARS = 450;

export async function computeVolumeStudy(symbol: string, side: string, openedAt: number) {
  const entry = Math.floor(openedAt / H1) * H1 - H1;
  let cs: C[] = await bingxKlines(symbol, "1h", entry + H1, HISTORY_BARS);
  if (!cs.some((c) => c.t === entry)) return { ok: false as const, reason: "нет свечи входа BingX 1H" };
  if (side === "short") cs = mirror(cs);
  // Only the consecutive tail (a gap restarts the series, as on the chart).
  let s = 0;
  for (let i = 1; i < cs.length; i++) if (cs[i]!.t - cs[i - 1]!.t !== H1) s = i;
  cs = cs.slice(s);
  const ohlc = cs.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }));
  const vol = new Map(cs.map((c) => [c.t, c.v]));
  const bars = new Map(ohlc.map((b) => [b.time, b]));
  const w = computeWyckoff(ohlc, vol, entry);
  const counts: Record<string, number> = {};
  for (const e of w.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const colors = colorWindow(cs.map((c) => c.t), (t) => vol.get(t) ?? null, entry, (t) => bars.get(t));
  return {
    ok: true as const,
    study: {
      version: 1,
      entryCandle: new Date(entry).toISOString(),
      mirroredForShort: side === "short",
      wyckoff: {
        phase: w.phase,
        entryPositionInRange: w.entryPositionInRange,
        rangeHeightPct: w.rangeHeightPct,
        counts,
      },
      colors,
      source: "bingx_1h_price_volume",
    },
  };
}

const failures = new Map<string, { at: number; reason: string }>();
const RETRY_MS = 6 * H1;
let started = false;

/** Background pass over published signals without a volume study, newest first. Never throws. */
export async function runVolumeStudyBackfill(limit = 25, gapMs = 1_000): Promise<number> {
  const cooling = [...failures.entries()].filter(([, f]) => Date.now() - f.at < RETRY_MS).map(([id]) => id);
  const { rows } = await pool.query(
    `SELECT id, symbol, side, opened_at FROM nh_signals
      WHERE live AND opened_at < now() - interval '5 minutes'
        AND NOT (COALESCE(details, '{}'::jsonb) ? 'volumeStudy')
        AND NOT (id::text = ANY($1::text[]))
      ORDER BY opened_at DESC LIMIT $2`,
    [cooling, limit],
  );
  let written = 0;
  for (const r of rows) {
    try {
      const res = await computeVolumeStudy(r.symbol, r.side, new Date(r.opened_at).getTime());
      if (!res.ok) failures.set(String(r.id), { at: Date.now(), reason: res.reason });
      else {
        await pool.query(
          `UPDATE nh_signals SET details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('volumeStudy', $2::jsonb) WHERE id = $1`,
          [r.id, JSON.stringify(res.study)],
        );
        failures.delete(String(r.id));
        written++;
      }
    } catch (err) {
      failures.set(String(r.id), { at: Date.now(), reason: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  if (rows.length) logger.info({ tried: rows.length, written }, "nihilist: volume study pass");
  return rows.length;
}

export function startVolumeStudyBackfill(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    let next = 10 * 60_000;
    try {
      if ((await runVolumeStudyBackfill()) > 0) next = 5_000;
    } catch (err) {
      logger.warn({ err }, "nihilist: volume study pass failed (non-critical)");
    }
    setTimeout(() => void tick(), next).unref?.();
  };
  setTimeout(() => void tick(), 60_000).unref?.();
}

export function volumeStudyFailures() {
  const reasons: Record<string, number> = {};
  for (const f of failures.values()) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  return reasons;
}
