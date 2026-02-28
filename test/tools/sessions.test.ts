/**
 * wire_sessions / wire_status 統合テスト
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestClientServer } from "../helpers/setup.js";
import { getDb } from "../../src/db.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

let client: Client;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const ctx = await createTestClientServer();
  client = ctx.client;
  cleanup = ctx.cleanup;
});

afterEach(async () => {
  await cleanup();
});

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

// ─────────────────────────────────────────────
// wire_sessions
// ─────────────────────────────────────────────

describe("wire_sessions", () => {
  test("登録済みセッション一覧を返す", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "session-a" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('session-b', NULL, 'busy', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({ name: "wire_sessions", arguments: {} });

    // Assert
    const text = getText(result);
    expect(text).toContain("session-a");
    expect(text).toContain("session-b");
    expect(text).toContain("(2)");
  });

  test("セッションがない場合はその旨を返す", async () => {
    // Act（何も登録せずに呼び出し）
    const result = await client.callTool({ name: "wire_sessions", arguments: {} });

    // Assert
    const text = getText(result);
    expect(text).toContain("登録されたセッションはありません");
  });
});

// ─────────────────────────────────────────────
// wire_status
// ─────────────────────────────────────────────

describe("wire_status", () => {
  test("ステータスを更新できる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "worker" } });

    // Act
    const result = await client.callTool({
      name: "wire_status",
      arguments: { status: "busy" },
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("busy");

    const db = getDb();
    const session = db.query<{ status: string }, [string]>(
      `SELECT status FROM sessions WHERE name = ?`
    ).get("worker");
    expect(session!.status).toBe("busy");
  });

  test("引数なしで全セッションのステータスを返す", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "me" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('other', NULL, 'busy', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_status",
      arguments: {},
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("me: idle");
    expect(text).toContain("other: busy");
  });
});
