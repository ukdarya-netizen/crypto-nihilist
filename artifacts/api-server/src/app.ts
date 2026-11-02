import express, { type Express } from "express";
import cors from "cors";
import nihilistRoutes from "./routes/nihilist";
import authRoutes from "./routes/auth";
import { requireUser } from "./lib/users";

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
app.use("/api/nh", requireUser);
app.use("/api", nihilistRoutes);

export default app;
