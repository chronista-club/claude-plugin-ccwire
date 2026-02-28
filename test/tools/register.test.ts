/**
 * wire_register / wire_unregister 統合テスト
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestClientServer } from "../helpers/setup.js";
import { getDb, getCurrentSessionName } from "../../src/db.js";
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

// ─────────────────────────────────────────────
// wire_register
// ─────────────────────────────────────────────

describe("wire_register", () => {
  test("新規セッションを登録できる", async () => {
    // Act
    const result = await client.callTool({ name: "wire_register", arguments: { name: "test-session" } });

    // Assert
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("test-session");
    expect(text).toContain("登録しました");

    const db = getDb();
    const session = db.query<{ name: string; status: string }, [string]>(
      `SELECT name, status FROM sessions WHERE name = ?`
    ).get("test-session");
    expect(session).toBeDefined();
    expect(session!.status).toBe("idle");
  });

  test("同名セッションの再登録で registered_at を維持する", async () => {
    // Arrange: 最初の登録
    await client.callTool({ name: "wire_register", arguments: { name: "persistent" } });
    const db = getDb();
    const first = db.query<{ registered_at: string }, [string]>(
      `SELECT registered_at FROM sessions WHERE name = ?`
    ).get("persistent");

    // 少し待って再登録
    await Bun.sleep(10);

    // Act
    await client.callTool({ name: "wire_register", arguments: { name: "persistent" } });

    // Assert: registered_at は変わらない
    const second = db.query<{ registered_at: string }, [string]>(
      `SELECT registered_at FROM sessions WHERE name = ?`
    ).get("persistent");
    expect(second!.registered_at).toBe(first!.registered_at);
  });

  test("登録後に currentSessionName がセットされる", async () => {
    // Act
    await client.callTool({ name: "wire_register", arguments: { name: "my-name" } });

    // Assert
    expect(getCurrentSessionName()).toBe("my-name");
  });
});

// ─────────────────────────────────────────────
// wire_unregister
// ─────────────────────────────────────────────

describe("wire_unregister", () => {
  test("自分自身のセッションを解除できる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "to-remove" } });

    // Act
    const result = await client.callTool({ name: "wire_unregister", arguments: {} });

    // Assert
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("登録を解除しました");

    const db = getDb();
    const session = db.query<{ name: string }, [string]>(
      `SELECT name FROM sessions WHERE name = ?`
    ).get("to-remove");
    expect(session).toBeNull();
  });

  test("他セッションの解除は拒否される", async () => {
    // Arrange: 2つのセッションを登録（自分は "me"）
    await client.callTool({ name: "wire_register", arguments: { name: "me" } });
    // 直接DBに他セッションを挿入
    const db = getDb();
    db.run(
      `INSERT INTO sessions (name, tmux_target, status, registered_at, last_seen)
       VALUES ('other', NULL, 'idle', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    );

    // Act
    const result = await client.callTool({ name: "wire_unregister", arguments: { name: "other" } });

    // Assert
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("他セッション");
  });

  test("未登録セッションの解除はエラーになる", async () => {
    // Arrange
    await client.callTool({ name: "wire_register", arguments: { name: "me" } });

    // Act
    const result = await client.callTool({ name: "wire_unregister", arguments: { name: "nonexistent" } });

    // Assert
    expect(result.isError).toBe(true);
  });
});
