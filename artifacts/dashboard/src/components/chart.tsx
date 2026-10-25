import { useEffect, useState } from "react";
import { CandlestickChart, X } from "lucide-react";
import { Segmented } from "./ui";
import { coin, get, price, type Candle, type Signal } from "../lib/api";

type Tf = "30m" | "1h" | "4h" | "1d";
const SPAN: Record<Tf, number> = { "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** Candles of the coin with the order block, entry, stop, TP1 and the signal bar (our chart, as AltBullet). */
export function CandleChart({ symbol, signal, tf }: { symbol: string; signal?: Signal | null; tf: Tf }) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  useEffect(() => {
    let alive = true;
    setCandles(null);
    get<{ candles: Candle[] }>(`/nh/candles?symbol=${encodeURIComponent(symbol)}&interval=${tf}&limit=160`)
      .then((d) => alive && setCandles(d.candles)).catch(() => alive && setCandles([]));
    return () => { alive = false; };
  }, [symbol, tf]);
  if (candles === null) return <p className="py-16 text-center text-sm text-muted">Загрузка свечей…</p>;
  if (!candles.length) return <p className="py-16 text-center text-sm text-muted">Свечей по монете нет (монета ещё не загружена).</p>;
  const W = 1000; const H = 420; const PAD = 64;
  const levels = signal ? [signal.block_top, signal.block_bottom, signal.entry, signal.stop, signal.tp1, signal.current_stop ?? signal.stop] : [];
  const hi = Math.max(...candles.map((c) => c.h), ...levels);
  const lo = Math.min(...candles.map((c) => c.l), ...levels);
  const y = (p: number) => 10 + ((hi - p) / (hi - lo || 1)) * (H - 30);
  const step = (W - PAD) / candles.length;
  const x = (i: number) => i * step + step / 2;
  const opened = signal ? new Date(signal.opened_at).getTime() : null;
  const sigIndex = opened === null ? -1 : candles.findIndex((c) => c.t + SPAN[tf] >= opened);
  const line = (p: number, cls: string, label: string) => (
    <g key={label}>
      <line x1="0" x2={W - PAD} y1={y(p)} y2={y(p)} className={cls} strokeWidth="1" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      <text x={W - PAD + 4} y={y(p) + 4} className="fill-current text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>{label} {price(p)}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[46vh] min-h-64 w-full text-muted" role="img" aria-label={`График ${coin(symbol)} ${tf}`}>
      {signal && <rect x="0" width={W - PAD} y={y(signal.block_top)} height={Math.max(1, y(signal.block_bottom) - y(signal.block_top))}
        className={signal.side === "long" ? "fill-up/10" : "fill-down/10"} />}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        return (
          <g key={c.t} className={up ? "text-up" : "text-down"}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <rect x={x(i) - step * 0.35} width={step * 0.7} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill="currentColor" opacity={up ? 0.85 : 0.9} />
          </g>
        );
      })}
      {sigIndex >= 0 && <line x1={x(sigIndex)} x2={x(sigIndex)} y1="0" y2={H} stroke="#efe7e1" strokeOpacity="0.35" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      {signal && [
        line(signal.entry, "stroke-foreground/70", "вход"),
        line(signal.stop, "stroke-down", "стоп"),
        line(signal.tp1, "stroke-up", "тейк 1"),
        ...(signal.current_stop !== null && signal.current_stop !== signal.stop ? [line(signal.current_stop, "stroke-warn", "стоп сейчас")] : []),
      ]}
    </svg>
  );
}

export function ChartModal({ symbol, signal, onClose }: { symbol: string; signal?: Signal | null; onClose: () => void }) {
  const [tf, setTf] = useState<Tf>((signal?.ltf as Tf) ?? "4h");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-3" onClick={onClose}>
      <div className="panel w-full max-w-5xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold">{coin(symbol)} <span className="font-mono text-xs text-muted">BingX · CoinGlass</span></p>
          <div className="flex items-center gap-2">
            <Segmented value={tf} onChange={(id) => setTf(id as Tf)} options={(["30m", "1h", "4h", "1d"] as Tf[]).map((t) => ({ id: t, label: t === "1d" ? "1D" : t }))} />
            <a href={`https://bingx.com/en/perpetual/${coin(symbol)}-USDT/`} target="_blank" rel="noreferrer" className="border border-border px-2 py-1.5 font-mono text-[11px] text-muted hover:text-foreground">BingX ↗</a>
            <button type="button" onClick={onClose} aria-label="Закрыть" className="p-1 text-muted hover:text-foreground"><X className="size-5" /></button>
          </div>
        </div>
        <CandleChart symbol={symbol} signal={signal} tf={tf} />
        {signal && <p className="mt-2 text-[11px] text-muted">Зона — ордер-блок {signal.htf === "1d" ? "1D" : signal.htf}; вертикаль — свеча сигнала; пунктир — вход, стоп, тейк 1{signal.current_stop !== null && signal.current_stop !== signal.stop ? ", текущий стоп" : ""}.</p>}
      </div>
    </div>
  );
}

/** Coin name + chart button (AltBullet TokenChartLink). */
export function CoinLink({ symbol, signal, className = "font-semibold" }: { symbol: string; signal?: Signal | null; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className={className}>{coin(symbol)}</span>
      <button type="button" title={`График ${coin(symbol)}`} aria-label={`График ${coin(symbol)}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="inline-flex size-6 items-center justify-center text-muted hover:text-primary">
        <CandlestickChart className="size-4" />
      </button>
      {open && <ChartModal symbol={symbol} signal={signal} onClose={() => setOpen(false)} />}
    </span>
  );
}
