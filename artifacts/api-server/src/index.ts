import app from "./app";
import { startEngine } from "./engine/runtime";
import { logger } from "./lib/logger";
import { ensureUserTables } from "./lib/users";
import { ensureRejectionTable } from "./engine/rejections";
import { ensureRelayTable } from "./lib/trading-relay";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  // Tables created by the code exist in EVERY database the server starts on
  // (dev included), so the publish diff never offers to DROP them.
  void Promise.all([ensureUserTables(), ensureRejectionTable(), ensureRelayTable()])
    .catch((err) => logger.error({ err }, "nihilist: table setup failed"));
  if (process.env.NIHILIST_ENGINE_ENABLED === "false") {
    logger.warn("Nihilist engine disabled by NIHILIST_ENGINE_ENABLED=false");
    return;
  }
  startEngine().catch((engineErr) => {
    logger.error({ err: engineErr }, "Nihilist engine failed to start");
  });
});
