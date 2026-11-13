import { useEffect, useState, type ReactElement } from "react";
import { LanguageToggle } from "./components/language-toggle";
import { Layout, OWNER_ROUTES, PUBLIC_ROUTES, useRoute, type Route } from "./components/layout";
import { AuthError, currentSession, get, onAuthError, saveSession } from "./lib/api";
import { Login, Register, ResetPassword } from "./pages/auth";
import Members from "./pages/members";
import Overview from "./pages/overview";
import Tracker from "./pages/tracker";
import Scanner from "./pages/scanner";
import Rejections from "./pages/rejections";
import History from "./pages/history";
import Health from "./pages/health";
import Metrics from "./pages/metrics";
import Reference from "./pages/reference";
import Strategies from "./pages/strategies";
import Btc from "./pages/btc";

export default function App() {
  const route = useRoute();
  const [state, setState] = useState<"checking" | "out" | "ok">(currentSession() ? "checking" : "out");
  const [notice, setNotice] = useState<string | null>(null);
  const signOut = (message: string | null) => { saveSession(null); setNotice(message); setState("out"); };

  useEffect(() => {
    // Phones open the positions first, as in AltBullet.
    if (!window.location.hash && window.innerWidth < 768) window.location.hash = "/tracker";
    const off = onAuthError((e) => signOut(e.code === "auth_required" ? null : e.message));
    if (currentSession()) {
      get<{ role: "owner" | "user"; name: string; email: string }>("/auth/me")
        .then((me) => { const s = currentSession(); if (s) saveSession({ ...s, role: me.role, name: me.name }); setState("ok"); })
        .catch((e) => signOut(e instanceof AuthError && e.code !== "auth_required" ? e.message : null));
    }
    return () => { off(); };
  }, []);

  const lang = <LanguageToggle className="fixed right-3 top-3 z-50" />;
  if (route === "/register") return <>{lang}<Register /></>;
  if (route === "/reset-password") return <>{lang}<ResetPassword /></>;
  if (state === "checking") return <div className="flex min-h-[100dvh] items-center justify-center text-sm text-muted">Загрузка…</div>;
  if (state === "out" || route === "/login") {
    return <>{lang}<Login notice={notice} onLogin={() => {
      setNotice(null); setState("ok");
      if (PUBLIC_ROUTES.includes(route)) window.location.hash = window.innerWidth < 768 ? "/tracker" : "/";
    }} /></>;
  }
  const owner = currentSession()?.role === "owner";
  const pages: Partial<Record<Route, ReactElement>> = {
    "/": <Overview />, "/tracker": <Tracker />, "/scanner": <Scanner />, "/rejections": <Rejections />, "/history": <History />, "/metrics": <Metrics />, "/btc": <Btc />,
    "/health": <Health />, "/reference": <Reference />, ...(owner ? { "/members": <Members />, "/strategies": <Strategies /> } : {}),
  };
  const allowed = owner || !OWNER_ROUTES.includes(route);
  return <Layout route={allowed ? route : "/"}>{(allowed && pages[route]) || <Overview />}</Layout>;
}
