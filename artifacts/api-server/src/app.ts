import express, { type Express } from "express";
import cors from "cors";
import nihilistRoutes from "./routes/nihilist";
import authRoutes from "./routes/auth";
import tradingSyncRoutes from "./routes/trading-sync";
import { ownerOnly, requireUser } from "./lib/users";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Accounts as in CAB (owner 2026-11-02): the dashboard API is open only to
// approved users with an active subscription (the PIN is no longer used).
app.use("/api", authRoutes);
// Trading bot (own token, not a dashboard login): position sync.
app.use("/api", tradingSyncRoutes);
app.use("/api/nh", requireUser);
// Owner only (2026-11-02): scanner, decisions, entry metrics, per-setup stats,
// post-entry trajectories and diagnostics. Users see positions, overview,
// history and the trading rules.
app.use(["/api/nh/scanner", "/api/nh/decisions", "/api/nh/rejections", "/api/nh/metrics", "/api/nh/diag"], ownerOnly);
app.use([/^\/api\/nh\/stats\/?$/, /^\/api\/nh\/signals\/[^/]+\/trajectory/], ownerOnly);
app.use("/api", nihilistRoutes);

export default app;
