import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json";
import { initDb, getDb, getCurrentSessionName, touchSession } from "./db.js";
import { registerRegisterTools } from "./tools/register.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerControlTools } from "./tools/control.js";
import { startWatcher, stopWatcher } from "./watcher.js";

// ─────────────────────────────────────────────
// Heartbeat: 定期的に last_seen を更新 (#15)
// ─────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; // 3分
let heartbeatTimer: Timer | null = null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const name = getCurrentSessionName();
    if (!name) return;
    try {
      touchSession(name);
    } catch { /* DB closed */ }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─────────────────────────────────────────────
// Graceful shutdown: unregister + cleanup (#15)
// ─────────────────────────────────────────────

function gracefulShutdown(): void {
  stopHeartbeat();
  stopWatcher();
  const name = getCurrentSessionName();
  if (name) {
    try {
      getDb().run(`DELETE FROM sessions WHERE name = ?`, [name]);
    } catch { /* DB already closed */ }
  }
}

// ─────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────

const server = new McpServer({
  name: "ccwire",
  version: pkg.version,
});

registerRegisterTools(server);
registerMessagingTools(server);
registerSessionsTools(server);
registerControlTools(server);

async function main() {
  await initDb();
  startWatcher();
  startHeartbeat();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGTERM", () => { gracefulShutdown(); process.exit(0); });
process.on("SIGINT", () => { gracefulShutdown(); process.exit(0); });
process.on("exit", () => { gracefulShutdown(); });

main().catch((err) => {
  console.error("ccwire server error:", err);
  gracefulShutdown();
  process.exit(1);
});
