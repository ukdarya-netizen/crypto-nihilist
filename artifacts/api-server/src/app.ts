import express, { type Express } from "express";
import cors from "cors";
import nihilistRoutes from "./routes/nihilist";
import { requireDashboardPin } from "./lib/dashboardAccess";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/nh", requireDashboardPin);
app.use("/api", nihilistRoutes);

export default app;
