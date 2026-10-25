import { useEffect, useState } from "react";
import { Layout, useRoute } from "./components/layout";
import { BrandMark, SLOGAN } from "./components/brand";
import { PinError, get, readPin, savePin, setCurrentPin } from "./lib/api";
import Overview from "./pages/overview";
import Tracker from "./pages/tracker";
import Scanner from "./pages/scanner";
import History from "./pages/history";
import Health from "./pages/health";
import Reference from "./pages/reference";

function PinGate({ onPin, wrong }: { onPin: (pin: string) => void; wrong: boolean }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex min-h-[100dvh] items-center justify-center p-4">
      <div className="panel w-full max-w-sm p-8 text-center">
        <BrandMark className="mx-auto size-28" />
        <p className="mt-5 font-display text-4xl">NIHILYST</p>
        <p className="mt-1 font-type text-xs tracking-[0.24em] text-primary">CRYPTO TRADING</p>
        <form onSubmit={(e) => { e.preventDefault(); onPin(value); }} className="mt-8 space-y-3">
          <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="PIN" autoFocus
            className="h-12 w-full border border-border bg-background px-4 text-center font-mono tracking-[0.3em]" />
          {wrong && <p className="text-xs text-down">Неверный PIN</p>}
          <button className="h-12 w-full bg-primary font-semibold text-white transition hover:bg-primary-deep">Войти</button>
        </form>
        <p className="mt-6 font-type text-[10px] tracking-[0.2em] text-muted">{SLOGAN}</p>
      </div>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const [state, setState] = useState<"checking" | "pin" | "wrong" | "ok">("checking");
  const check = (pin: string) => {
    setCurrentPin(pin);
    get("/nh/status").then(() => { savePin(pin); setState("ok"); })
      .catch((e) => setState(e instanceof PinError ? (pin ? "wrong" : "pin") : "ok"));
  };
  useEffect(() => {
    check(readPin());
    // Phones open the positions first, as in AltBullet.
    if (!window.location.hash && window.innerWidth < 768) window.location.hash = "/tracker";
  }, []);
  if (state === "checking") return <div className="flex min-h-[100dvh] items-center justify-center text-sm text-muted">Загрузка…</div>;
  if (state !== "ok") return <PinGate onPin={check} wrong={state === "wrong"} />;
  const page = { "/": <Overview />, "/tracker": <Tracker />, "/scanner": <Scanner />, "/history": <History />, "/health": <Health />, "/reference": <Reference /> }[route];
  return <Layout route={route}>{page}</Layout>;
}
