import { getLang, setLang, type Lang } from "../lib/i18n";

const OPTIONS: Array<{ lang: Lang; label: string; title: string }> = [
  { lang: "ru", label: "RU", title: "Русский" },
  { lang: "en", label: "EN", title: "English" },
];

/** RU / EN switch as in CAB; choosing a language reloads the page. */
export function LanguageToggle({ className = "" }: { className?: string }) {
  const current = getLang();
  return (
    <div data-testid="language-toggle" className={`inline-flex items-center border border-border bg-card/60 p-0.5 font-mono text-[11px] font-semibold ${className}`}>
      {OPTIONS.map((o) => (
        <button key={o.lang} type="button" aria-pressed={current === o.lang} title={o.title}
          onClick={() => { if (current !== o.lang) setLang(o.lang); }}
          className={`px-2 py-1 leading-none ${current === o.lang ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
