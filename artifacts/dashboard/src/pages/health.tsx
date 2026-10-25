import { Kpi, Panel } from "../components/ui";
import { usePoll, when, type Status } from "../lib/api";

export default function Health() {
  const { data } = usePoll<Status>("/nh/status", 15_000);
  if (!data) return <Panel><p className="text-sm text-muted">Загрузка…</p></Panel>;
  const e = data.engine;
  const cg = data.coinglass;
  const h = data.health.coinglass;
  const ago = e.lastCycleAt ? Math.round((Date.now() - e.lastCycleAt) / 60_000) : null;
  const healthy = e.leaseAcquired && ago !== null && ago <= 35;
  return (
    <div className="space-y-4 md:space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Движок" value={healthy ? "работает" : e.leaseAcquired ? "ждёт цикл" : "ждёт блокировку"} toneClass={healthy ? "text-up" : "text-warn"}
          hint={`запущен ${when(e.startedAt)}`} />
        <Kpi label="Последний цикл" value={ago === null ? "—" : `${ago} мин`} hint={e.lastCycleMs ? `длился ${Math.round(e.lastCycleMs / 1000)} с` : "ещё не было"} />
        <Kpi label="Монеты" value={`${e.ready}/${e.universe}`} hint={e.phase && e.phase !== "running"
          ? (e.phase === "loading_db" ? `запуск: читаю базу ${e.loadedFromDb ?? 0}/${e.universe}` : `запуск: ${e.phase}`)
          : e.backfillPending ? `догружается история: ${e.backfillPending}` : "история загружена"} />
        <Kpi label="Сделки" value={data.signals.open} hint={`открыто · закрыто ${data.signals.closed}`} />
      </div>
      <Panel title="Последний цикл">
        <dl className="grid grid-cols-2 gap-y-2 font-mono text-sm md:grid-cols-4">
          <dt className="text-muted">решений</dt><dd>{e.lastCycleDecisions}</dd>
          <dt className="text-muted">новых сигналов</dt><dd>{e.lastCycleSignals}</dd>
          <dt className="text-muted">монет без свечей</dt><dd className={e.lastCycleRefreshFailed ? "text-warn" : ""}>{e.lastCycleRefreshFailed}</dd>
          <dt className="text-muted">ошибка движка</dt><dd className={e.lastError ? "text-down" : ""}>{e.lastError ?? "нет"}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted">Монета без свечей в цикле не оценивается: нет данных — нет сигнала.</p>
      </Panel>
      <Panel title="CoinGlass">
        <dl className="grid grid-cols-2 gap-y-2 font-mono text-sm md:grid-cols-4">
          <dt className="text-muted">запросов</dt><dd>{cg.started}</dd>
          <dt className="text-muted">успешно</dt><dd className="text-up">{cg.ok}</dd>
          <dt className="text-muted">ошибок</dt><dd className={cg.failed ? "text-down" : ""}>{cg.failed}</dd>
          <dt className="text-muted">лимит 429</dt><dd className={cg.rateLimited ? "text-warn" : ""}>{cg.rateLimited}</dd>
          <dt className="text-muted">интервал</dt><dd>{cg.minGapMs} мс</dd>
          <dt className="text-muted">ключей</dt><dd className={cg.keys ? "" : "text-down"}>{cg.keys}</dd>
          <dt className="text-muted">пауза</dt><dd>{cg.cooldownMs ? `${Math.round(cg.cooldownMs / 1000)} с` : "нет"}</dd>
          <dt className="text-muted">ошибок подряд</dt><dd>{h?.consecutiveFailures ?? 0}</dd>
        </dl>
        {h?.lastError && <p className="mt-3 break-all font-mono text-xs text-down">Последняя ошибка ({when(h.lastErrorAt)}): {h.lastError}</p>}
      </Panel>
    </div>
  );
}
