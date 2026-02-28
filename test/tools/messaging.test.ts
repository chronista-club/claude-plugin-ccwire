/**
 * wire_send / wire_receive / wire_broadcast / wire_ack 統合テスト
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

/** テキストを取り出すヘルパー */
function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

// ─────────────────────────────────────────────
// wire_send
// ─────────────────────────────────────────────

describe("wire_send", () => {
  test("メッセージを送信できる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "sender" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('receiver', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_send",
      arguments: { to: "receiver", content: "hello" },
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("メッセージ送信完了");
    expect(text).toContain("receiver");

    const msgs = db.query<{ content: string; status: string }, []>(
      `SELECT content, status FROM messages WHERE "to" = 'receiver'`
    ).all();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hello");
    expect(msgs[0].status).toBe("pending");
  });

  test("存在しないセッション宛はエラーになる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "sender" } });

    // Act
    const result = await client.callTool({
      name: "wire_send",
      arguments: { to: "ghost", content: "hello" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("見つかりません");
  });

  test("未登録状態での送信はエラーになる", async () => {
    // Act（register せずに send）
    const result = await client.callTool({
      name: "wire_send",
      arguments: { to: "someone", content: "hello" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("wire_register");
  });
});

// ─────────────────────────────────────────────
// wire_receive
// ─────────────────────────────────────────────

describe("wire_receive", () => {
  test("自分宛の pending メッセージを取得し delivered にする", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "receiver" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('sender', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('msg-1', 'sender', 'receiver', 'task_request', 'do something', ?, NULL, 'pending')`,
      [new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_receive",
      arguments: {},
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("1件");
    expect(text).toContain("do something");

    // メッセージが delivered に更新されている
    const msg = db.query<{ status: string }, [string]>(
      `SELECT status FROM messages WHERE id = ?`
    ).get("msg-1");
    expect(msg!.status).toBe("delivered");
  });

  test("メッセージがない場合は空を返す", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "lonely" } });

    // Act
    const result = await client.callTool({
      name: "wire_receive",
      arguments: {},
    });

    // Assert
    expect(getText(result)).toContain("未読メッセージはありません");
  });

  test("limit パラメータで取得数を制限できる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "receiver" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('sender', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
         VALUES (?, 'sender', 'receiver', 'task_request', ?, ?, NULL, 'pending')`,
        [`msg-${i}`, `message ${i}`, new Date().toISOString()]
      );
    }

    // Act
    const result = await client.callTool({
      name: "wire_receive",
      arguments: { limit: 2 },
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("2件");
  });
});

// ─────────────────────────────────────────────
// wire_broadcast
// ─────────────────────────────────────────────

describe("wire_broadcast", () => {
  test("全セッション宛にメッセージを送信できる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "broadcaster" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('listener1', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_broadcast",
      arguments: { content: "attention everyone" },
    });

    // Assert
    const text = getText(result);
    expect(text).toContain("ブロードキャスト送信完了");
    expect(text).toContain("1"); // 対象セッション数

    const msg = db.query<{ to: string; content: string }, []>(
      `SELECT "to", content FROM messages WHERE "to" = '*'`
    ).get();
    expect(msg!.content).toBe("attention everyone");
  });

  test("broadcast は受信者ごとに1回だけ配信される", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "broadcaster" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('listener', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // broadcast を送信
    await client.callTool({
      name: "wire_broadcast",
      arguments: { content: "once only" },
    });

    // listener として受信（currentSessionName を切替）
    // 直接 DB を操作して listener 視点でテスト
    const { setCurrentSessionName } = await import("../../src/db.js");
    setCurrentSessionName("listener");

    // Act: 1回目の受信
    const result1 = await client.callTool({
      name: "wire_receive",
      arguments: {},
    });
    // Act: 2回目の受信
    const result2 = await client.callTool({
      name: "wire_receive",
      arguments: {},
    });

    // Assert
    expect(getText(result1)).toContain("1件");
    expect(getText(result2)).toContain("未読メッセージはありません");
  });
});

// ─────────────────────────────────────────────
// wire_ack
// ─────────────────────────────────────────────

describe("wire_ack", () => {
  test("自分宛メッセージを acknowledged にできる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "receiver" } });
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('sender', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('msg-ack', 'sender', 'receiver', 'task_request', 'test', ?, NULL, 'delivered')`,
      [new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_ack",
      arguments: { message_id: "msg-ack" },
    });

    // Assert
    expect(getText(result)).toContain("確認済み");
    const msg = db.query<{ status: string }, [string]>(
      `SELECT status FROM messages WHERE id = ?`
    ).get("msg-ack");
    expect(msg!.status).toBe("acknowledged");
  });

  test("他人宛メッセージの ack は拒否される", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "outsider" } });
    const db = getDb();
    db.run(
      `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
       VALUES ('msg-other', 'alice', 'bob', 'task_request', 'secret', ?, NULL, 'delivered')`,
      [new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({
      name: "wire_ack",
      arguments: { message_id: "msg-other" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("自分宛でも自分発でもない");
  });

  test("存在しないメッセージの ack はエラーになる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "me" } });

    // Act
    const result = await client.callTool({
      name: "wire_ack",
      arguments: { message_id: "nonexistent" },
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("見つかりません");
  });
});
