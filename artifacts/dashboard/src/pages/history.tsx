import { useState } from "react";
import { Segmented } from "../components/ui";
import { SignalHistory, type TradeStatus } from "../components/signal-history";

export default function History() {
  const [days, setDays] = useState(90);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<"" | TradeStatus>("");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Segmented value={live} onChange={(value) => setLive(value as boolean)} options={[{ id: false, label: "все сетапы" }, { id: true, label: "только канал" }]} />
        <Segmented value={days} onChange={(value) => setDays(value as number)} options={[{ id: 7, label: "7 дн" }, { id: 30, label: "30 дн" }, { id: 90, label: "90 дн" }, { id: 3650, label: "всё" }]} />
      </div>
      <SignalHistory days={days} live={live} status={status} onStatus={setStatus} limit={500} title="Все сигналы" />
    </div>
  );
}
