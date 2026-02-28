import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json";
import { initDb } from "./db.js";
import { registerRegisterTools } from "./tools/register.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerControlTools } from "./tools/control.js";

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ccwire server error:", err);
  process.exit(1);
});
