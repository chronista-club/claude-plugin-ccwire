/**
 * テストヘルパー — t-wada 流テスト基盤
 *
 * 設計方針:
 * - モック最小主義: SQLite は実物（:memory:）を使う
 * - テストの独立性: 各テストで DB を再初期化
 * - tmux 依存は分離（CI 環境対応）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pkg from "../../package.json";
import { initDb, getDb, setCurrentSessionName } from "../../src/db.js";
import { registerRegisterTools } from "../../src/tools/register.js";
import { registerMessagingTools } from "../../src/tools/messaging.js";
import { registerSessionsTools } from "../../src/tools/sessions.js";
import { registerControlTools } from "../../src/tools/control.js";

/**
 * テスト用 DB を初期化する。
 * in-memory SQLite を使い、テスト間の状態漏れを防ぐ。
 */
export async function setupTestDb(): Promise<void> {
  await initDb(":memory:");
  setCurrentSessionName(null);
}

/**
 * テスト用 DB を閉じる。
 */
export function teardownTestDb(): void {
  try {
    getDb().close();
  } catch {
    // already closed
  }
}

/**
 * MCP Client/Server ペアを作成する。
 * 統合テスト用: InMemoryTransport で接続し、全ツールを登録済みの状態で返す。
 */
export async function createTestClientServer(): Promise<{
  client: Client;
  server: McpServer;
  cleanup: () => Promise<void>;
}> {
  await setupTestDb();

  const server = new McpServer({
    name: "ccwire-test",
    version: pkg.version,
  });

  registerRegisterTools(server);
  registerMessagingTools(server);
  registerSessionsTools(server);
  registerControlTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    cleanup: async () => {
      await client.close();
      await server.close();
      teardownTestDb();
    },
  };
}

/**
 * テスト用のセッションを DB に直接挿入する。
 * Arrange フェーズで使うユーティリティ。
 */
export function insertTestSession(
  name: string,
  opts: {
    tmux_target?: string | null;
    pid?: number | null;
    status?: "idle" | "busy" | "done";
    registered_at?: string;
    last_seen?: string;
  } = {}
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO sessions (name, tmux_target, pid, status, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      name,
      opts.tmux_target ?? null,
      opts.pid ?? null,
      opts.status ?? "idle",
      opts.registered_at ?? now,
      opts.last_seen ?? now,
    ]
  );
}

/**
 * テスト用のメッセージを DB に直接挿入する。
 */
export function insertTestMessage(
  id: string,
  opts: {
    from: string;
    to: string;
    type?: string;
    content?: string;
    timestamp?: string;
    reply_to?: string | null;
    status?: string;
  }
): void {
  const db = getDb();
  db.run(
    `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.from,
      opts.to,
      opts.type ?? "task_request",
      opts.content ?? "test message",
      opts.timestamp ?? new Date().toISOString(),
      opts.reply_to ?? null,
      opts.status ?? "pending",
    ]
  );
}
