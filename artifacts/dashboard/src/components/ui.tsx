import type { ReactNode } from "react";

export function Panel({ title, right, children, className = "" }: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`panel p-4 md:p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="label !text-[11px] !text-foreground/80">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, toneClass = "" }: { label: string; value: ReactNode; hint?: ReactNode; toneClass?: string }) {
  return (
    <div className="panel p-4">
      <p className="label">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string | number | boolean>({ value, options, onChange }: {
  value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void;
}) {
  return (
    <div className="flex border border-border text-xs">
      {options.map((o) => (
        <button key={String(o.id)} type="button" onClick={() => onChange(o.id)} aria-pressed={value === o.id}
          className={`whitespace-nowrap px-3 py-1.5 font-mono transition-colors ${value === o.id ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SideTag({ side }: { side: "long" | "short" }) {
  return (
    <span className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase ${side === "long" ? "border-up/40 text-up" : "border-down/40 text-down"}`}>
      {side === "long" ? "лонг" : "шорт"}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function Table({ head, children, minWidth = 720 }: { head: string[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="text-left">{head.map((h) => <th key={h} className="label pb-2 pr-3 font-normal">{h}</th>)}</tr>
        </thead>
        <tbody className="tabular">{children}</tbody>
      </table>
    </div>
  );
}
