/**
 * wire_thread / wire_control 統合テスト
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
// wire_thread
// ─────────────────────────────────────────────

describe("wire_thread", () => {
  test("reply_to チェーンでスレッドを構築できる", async () => {
    // Arrange: root → reply1 → reply2
    const db = getDb();
    const t1 = "2025-01-01T00:00:00.000Z";
    const t2 = "2025-01-01T00:01:00.000Z";
    const t3 = "2025-01-01T00:02:00.000Z";

    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('root', 'alice', 'bob', 'question', 'what?', ?, NULL, 'delivered')`,
      [t1]
    );
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('reply1', 'bob', 'alice', 'response', 'this!', ?, 'root', 'delivered')`,
      [t2]
    );
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('reply2', 'alice', 'bob', 'response', 'thanks', ?, 'reply1', 'delivered')`,
      [t3]
    );

    // Act
    const result = await client.callTool({
      name: "wire_thread",
      arguments: { message_id: "root" },
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("3 messages");
    expect(text).toContain("root");
    expect(text).toContain("what?");
    expect(text).toContain("this!");
    expect(text).toContain("thanks");
  });

  test("途中のメッセージIDからでもスレッド全体を返す", async () => {
    // Arrange
    const db = getDb();
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('msg-a', 'alice', 'bob', 'question', 'start', '2025-01-01T00:00:00Z', NULL, 'delivered')`
    );
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('msg-b', 'bob', 'alice', 'response', 'middle', '2025-01-01T00:01:00Z', 'msg-a', 'delivered')`
    );
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('msg-c', 'alice', 'bob', 'response', 'end', '2025-01-01T00:02:00Z', 'msg-b', 'delivered')`
    );

    // Act: 途中のメッセージから検索
    const result = await client.callTool({
      name: "wire_thread",
      arguments: { message_id: "msg-b" },
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("3 messages");
    expect(text).toContain("msg-a"); // root
  });

  test("存在しないメッセージIDはエラーになる", async () => {
    // Act
    const result = await client.callTool({
      name: "wire_thread",
      arguments: { message_id: "nonexistent" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("見つからない");
  });
});

// ─────────────────────────────────────────────
// wire_control
// ─────────────────────────────────────────────

describe("wire_control", () => {
  test("tmux_target なしセッションへの制御はエラーになる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "controller" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('no-tmux', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_control",
      arguments: { session: "no-tmux", action: "enter" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("tmux_target が設定されていません");
  });

  test("action=text で空テキストはエラーになる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "controller" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('target', 'session:0.0', 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_control",
      arguments: { session: "target", action: "text" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("空でない text パラメータが必須");
  });
});
