/**
 * Final tuning study (owner 2026-11-09; back 2026-11-13 for Lucy's VSA and the shorts) inside the published app — the workspace cannot reach the production
 * database. Header x-trading-token = NIHILIST_TRADING_TOKEN (the same secret as the trading bot's position sync).
 *   GET /api/nh-study/start            — starts the study in the background (once at a time); returns the state
 *   GET /api/nh-study/status           — progress, last log lines, files ready
 *   GET /api/nh-study/file/:name       — trades.csv | rejects.csv | trajectory.csv.gz | mf-cache-v3.jsonl
 *   GET /api/nh-study/exits/start | /exits/status | /exits/file/:name (path.csv.gz | ob.csv.gz | meta.csv | btc.csv.gz) | /exits/clear — exit and
 *       order-block study (owner 2026-11-13): 15m path with delta, spot delta and OI from 150 bars before the entry to
 *       the close (closed signals); 1h volumes from the order block through the approach to the break (every signal).
 * Read-only on the database; nothing else in the app changes.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { Router, type IRouter, type Request, type Response } from "express";
import { tradingToken } from "../lib/trading-relay";
import { tokenMatches } from "./trading-sync";
import { STUDY_DIR, startFinalStudy, studyState } from "../analysis/final-study";
import { clearExitStudy, exitFile, exitState, startExitStudy } from "../analysis/exit-study";

const FILES = new Set(["trades.csv", "rejects.csv", "trajectory.csv.gz", "mf-cache-v3.jsonl"]);
const router: IRouter = Router();

function allowed(req: Request, res: Response): boolean {
  res.setHeader("Cache-Control", "no-store");
  const expected = tradingToken();
  if (!expected) { res.status(503).json({ error: "token_not_configured" }); return false; }
  if (!tokenMatches(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}
const files = () => Object.fromEntries([...FILES].map((f) => {
  const p = `${STUDY_DIR}/${f}`;
  return [f, existsSync(p) ? statSync(p).size : null];
}));

router.get("/nh-study/start", (req, res) => {
  if (!allowed(req, res)) return;
  const started = startFinalStudy();
  res.json({ started, state: studyState, files: files() });
});
router.get("/nh-study/status", (req, res) => {
  if (!allowed(req, res)) return;
  res.json({ state: studyState, files: files() });
});
router.get("/nh-study/file/:name", (req, res) => {
  if (!allowed(req, res)) return;
  const name = String(req.params.name);
  const p = `${STUDY_DIR}/${name}`;
  if (!FILES.has(name) || !existsSync(p)) { res.status(404).json({ error: "not_ready" }); return; }
  res.setHeader("Content-Type", name.endsWith(".gz") ? "application/gzip" : "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  createReadStream(p).pipe(res);
});

router.get("/nh-study/exits/start", (req, res) => {
  if (!allowed(req, res)) return;
  res.json({ started: startExitStudy(), state: exitState });
});
const EXIT_FILES = new Set(["path.csv.gz", "ob.csv.gz", "meta.csv", "btc.csv.gz"]);
router.get("/nh-study/exits/status", (req, res) => {
  if (!allowed(req, res)) return;
  res.json({ state: exitState });
});
// Built from the database on request (owner 2026-11-14: survives restarts).
router.get("/nh-study/exits/file/:name", async (req, res) => {
  if (!allowed(req, res)) return;
  const name = String(req.params.name);
  if (!EXIT_FILES.has(name)) { res.status(404).json({ error: "unknown_file" }); return; }
  const f = await exitFile(name).catch(() => null);
  if (!f) { res.status(404).json({ error: "not_ready" }); return; }
  res.setHeader("Content-Type", name.endsWith(".gz") ? "application/gzip" : "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("X-Rows", String(f.rows));
  res.send(f.body);
});
router.get("/nh-study/exits/clear", async (req, res) => {
  if (!allowed(req, res)) return;
  if (exitState.running) { res.status(409).json({ error: "running" }); return; }
  res.json({ deleted: await clearExitStudy() });
});

export default router;
