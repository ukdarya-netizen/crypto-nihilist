export function BrandMark({ className = "size-10" }: { className?: string }) {
  return (
    <img src={`${import.meta.env.BASE_URL}avatar.jpg`} alt="" aria-hidden="true"
      className={`shrink-0 rounded-full object-cover ring-1 ring-primary/60 shadow-[0_0_18px_rgba(227,38,46,0.35)] ${className}`} />
  );
}

export function BrandLockup() {
  return (
    <div className="flex items-center gap-3">
      <BrandMark />
      <div className="leading-none">
        <p className="font-display text-[22px] text-foreground">NIHILYST</p>
        <p className="mt-1 font-type text-[10px] tracking-[0.22em] text-primary">CRYPTO TRADING</p>
      </div>
    </div>
  );
}

export const SLOGAN = "NO RULES · NO MASTERS · ONLY PROFIT";
