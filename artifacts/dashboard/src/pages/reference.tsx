import type { ReactNode } from "react";
import { isOwner } from "../lib/api";

/**
 * Reference (owner 2026-11-10): one clear page — the idea, how a signal is found (3 steps), and how a trade
 * is managed, longs and shorts side by side. Users get the same page without the method's settings.
 */

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-3">
    <p className="label">{title}</p>
    {children}
  </section>
);

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="panel relative p-4">
      <span className="absolute right-4 top-3 font-mono text-3xl font-semibold text-primary/25">{n}</span>
      <p className="pr-8 font-semibold">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-foreground/75">{children}</p>
    </div>
  );
}

type Row = { k: string; long: ReactNode; short: ReactNode };

function SideTable({ rows }: { rows: Row[] }) {
  return (
    <div className="panel overflow-hidden">
      <div className="grid grid-cols-2 border-b border-border text-xs md:grid-cols-[minmax(90px,0.7fr)_1fr_1fr]">
        <div className="hidden p-3 md:block" />
        <div className="p-3 md:border-l md:border-border font-mono font-semibold uppercase tracking-wider text-up">Лонг</div>
        <div className="border-l border-border p-3 font-mono font-semibold uppercase tracking-wider text-down">Шорт</div>
      </div>
      {rows.map((r) => (
        <div key={r.k} className="grid grid-cols-2 border-t border-border text-sm first:border-t-0 md:grid-cols-[minmax(90px,0.7fr)_1fr_1fr]">
          <div className="col-span-2 px-3 pt-3 text-xs text-muted md:col-span-1 md:pb-3">{r.k}</div>
          <div className="p-3 leading-relaxed md:border-l md:border-border">{r.long}</div>
          <div className="border-l border-border p-3 leading-relaxed">{r.short}</div>
        </div>
      ))}
    </div>
  );
}

const Note = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="panel p-4">
    <p className="font-semibold">{title}</p>
    <p className="mt-2 text-sm leading-relaxed text-foreground/75">{children}</p>
  </div>
);

export default function Reference() {
  const owner = isOwner();
  const rows: Row[] = [
    {
      k: "Стоп",
      long: owner ? "Под минимумом реакции в блоке − 0,1 ATR младшего ТФ и ещё 3% ниже" : "Указан в сигнале — за зоной реакции цены в ордер-блоке",
      short: owner ? "Над максимумом реакции в блоке + 0,1 ATR младшего ТФ и ещё 3% выше" : "Указан в сигнале — за зоной реакции цены в ордер-блоке",
    },
    { k: "Безубыток", long: "На +5% стоп переносится на вход", short: "На +5% стоп переносится на вход" },
    { k: "Частичная фиксация", long: "На +10% закрывается 50% позиции", short: "На +10% закрывается 50% позиции" },
    {
      k: "Трейлинг",
      long: "Остаток: с +15% стоп идёт на 10 п.п. ниже пика и только подтягивается (пик +24% → +14% у остатка)",
      short: "Остаток: с +15% стоп идёт на 10 п.п. ниже пика и только подтягивается (пик +24% → +14% у остатка)",
    },
    { k: "Удержание", long: "До 7 дней (ОБ 4h) или 21 дня (ОБ 1D), затем закрытие по цене", short: "До 7 дней (ОБ 4h) или 21 дня (ОБ 1D), затем закрытие по цене" },
    ...(owner ? [{
      k: "Фильтр входа",
      long: "Стоп не ближе 7%, ордер-блоку не больше 300 ч, высота блока от 4% цены, ATR(14) 1H от 1,9%",
      short: "Нет",
    }] : []),
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <section className="panel border-primary/30 p-5 md:p-6">
        <p className="label">Идея</p>
        <p className="mt-2 text-lg font-semibold md:text-xl">Smart Money: возврат в ордер-блок и слом структуры</p>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-foreground/75">
          Старший таймфрейм (4h или 1D) показывает, где крупный игрок оставил ордер-блок. Младший (30m или 1h) — момент, когда цена в этом блоке развернулась.
          Вход — по закрытию свечи, сломавшей структуру. Лонги и шорты, фьючерсы BingX.
        </p>
      </section>

      <Section title={owner ? "Как находится сигнал (лонг; шорт — зеркально)" : "Как находится сигнал"}>
        <div className="grid gap-3 md:grid-cols-3">
          <Step n={1} title="Ордер-блок">
            {owner ? "Активный блок на 4h или 1D, не снятый на последней закрытой свече старшего ТФ." : "На старшем таймфрейме есть действующий ордер-блок."}
          </Step>
          <Step n={2} title="Возврат в блок">
            {owner ? "Свеча младшего ТФ заходит в блок. Если цена ушла за дальний край блока, даже тенью, блок сломан — сигнала нет." : "Цена возвращается в этот блок и не пробивает его насквозь."}
          </Step>
          <Step n={3} title="Слом структуры (CHoCH)">
            {owner ? "Не позже 12 свечей после касания закрытие за последним внутренним экстремумом младшего ТФ — сигнал." : "На младшем таймфрейме структура ломается в сторону сделки — это сигнал."}
          </Step>
        </div>
      </Section>

      <Section title="Как ведётся сделка">
        <SideTable rows={rows} />
        <p className="text-xs text-muted">Сделки ведутся по 5-минутным свечам.</p>
        <div className="panel border-primary/30 p-4 text-sm leading-relaxed">
          <p className="font-semibold">BTC — свои правила</p>
          <p className="mt-2 text-foreground/75">
            BTC движется в разы меньше альтов, поэтому проценты альтов к нему не применяются.{owner ? " Стоп — 0,3% за структурным." : ""} Тейк 1 — 1,5R: закрывается 50%, стоп переносится на вход. Тейк 2 — 3R: закрывается остаток. Без безубытка на +5%, без фиксации 50% на +10% и без трейлинга.
          </p>
        </div>
      </Section>

      <Section title="Оповещения">
        <div className="grid gap-3 md:grid-cols-2">
          <Note title="Ход сделки">+5% (стоп в безубыток), +8%, +10% (закрыто 50%), +15% (включён трейлинг), дальше каждые +5%; отдельно — закрытие сделки.</Note>
          <Note title="Отчёты">Каждый день в 22:00, по воскресеньям в 10:00 и 1-го числа в 11:00 (Дубай) — в Telegram-бот и канал.</Note>
        </div>
      </Section>

      {owner && (
        <Section title="Метод — только владелец">
          <div className="grid gap-3 md:grid-cols-2">
            <Note title="8 сетапов">{"{ОБ 4h, ОБ 1D} × {слом 30m, слом 1h} × {лонг, шорт}. Статистика по каждому отдельно."}</Note>
            <Note title="Отказ">Стоп дальше 20% · по монете уже открыта сделка в эту сторону · лонг не прошёл фильтр входа. Одна сделка на блок; причина пишется в «Отклонённые сигналы».</Note>
          </div>
        </Section>
      )}
    </div>
  );
}
