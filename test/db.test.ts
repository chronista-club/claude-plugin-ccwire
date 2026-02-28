/**
 * db.ts 仕様化テスト — t-wada 流
 *
 * テスト名は「何をしたら何が起きる」で仕様を表現する。
 * AAA パターン: Arrange → Act → Assert
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  setupTestDb,
  teardownTestDb,
  insertTestSession,
  insertTestMessage,
} from "./helpers/setup.js";
import {
  getDb,
  setCurrentSessionName,
  auditLog,
  cleanStaleAuditLogs,
  cleanStaleSessions,
  cleanStaleMessages,
  touchSession,
  resolveCurrentSession,
  isPidAlive,
} from "../src/db.js";

beforeEach(async () => {
  await setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

// ─────────────────────────────────────────────
// initDb
// ─────────────────────────────────────────────

describe("initDb", () => {
  test("DB初期化後にテーブルが存在する", () => {
    const db = getDb();
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
      .all()
      .map((r) => r.name);

    expect(tables).toContain("sessions");
    expect(tables).toContain("messages");
    expect(tables).toContain("broadcast_deliveries");
    expect(tables).toContain("audit_log");
  });

  test("getDb() が Database インスタンスを返す", () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(typeof db.run).toBe("function");
    expect(typeof db.query).toBe("function");
  });
});

// ─────────────────────────────────────────────
// cleanStaleSessions
// ─────────────────────────────────────────────

describe("cleanStaleSessions", () => {
  test("TTL超過セッションを削除する", () => {
    // Arrange: 15分前の last_seen を持つセッション（TTL 10分超過）
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    insertTestSession("stale-session", { last_seen: staleTime });

    // Act
    cleanStaleSessions();

    // Assert
    const db = getDb();
    const result = db
      .query<{ name: string }, []>(`SELECT name FROM sessions`)
      .all();
    expect(result).toHaveLength(0);
  });

  test("TTL内セッションは削除しない", () => {
    // Arrange: 5分前（TTL 10min 以内）
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    insertTestSession("alive-session", { last_seen: recentTime });

    // Act
    cleanStaleSessions();

    // Assert
    const db = getDb();
    const result = db
      .query<{ name: string }, []>(`SELECT name FROM sessions`)
      .all();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("alive-session");
  });

  test("tmux_target なしセッションはTTLのみで判定する", () => {
    // Arrange: TTL内、tmux_target なし
    insertTestSession("no-tmux-session", { tmux_target: null });

    // Act
    cleanStaleSessions(true); // fullCheck でもTTLのみ

    // Assert
    const db = getDb();
    const result = db
      .query<{ name: string }, []>(`SELECT name FROM sessions`)
      .all();
    expect(result).toHaveLength(1);
  });

  test("PID が死んだセッションを削除する", () => {
    // Arrange: 存在しない PID（99999999）を持つセッション
    insertTestSession("dead-pid-session", { pid: 99999999 });

    // Act
    cleanStaleSessions();

    // Assert
    const db = getDb();
    const result = db
      .query<{ name: string }, []>(`SELECT name FROM sessions`)
      .all();
    expect(result).toHaveLength(0);
  });

  test("PID が生きているセッションは削除しない", () => {
    // Arrange: 自プロセスの PID（確実に生きている）
    insertTestSession("alive-pid-session", { pid: process.pid });

    // Act
    cleanStaleSessions();

    // Assert
    const db = getDb();
    const result = db
      .query<{ name: string }, []>(`SELECT name FROM sessions`)
      .all();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("alive-pid-session");
  });

  test("PID なしセッションは PID チェックをスキップする", () => {
    // Arrange: pid = null のセッション（TTL 内）
    insertTestSession("no-pid-session", { pid: null });

    // Act
    cleanStaleSessions();

    // Assert
    const db = getDb();
    const result = db
      .query<{ name: string }, []>(`SELECT name FROM sessions`)
      .all();
    expect(result).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
// isPidAlive
// ─────────────────────────────────────────────

describe("isPidAlive", () => {
  test("自プロセスの PID は生きている", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("存在しない PID は死んでいる", () => {
    expect(isPidAlive(99999999)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// cleanStaleMessages
// ─────────────────────────────────────────────

describe("cleanStaleMessages", () => {
  test("TTL超過の非pending メッセージを削除する", () => {
    // Arrange
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    insertTestSession("sender");
    insertTestSession("receiver");
    insertTestMessage("msg-old", {
      from: "sender",
      to: "receiver",
      timestamp: staleTime,
      status: "delivered",
    });

    // Act
    const deleted = cleanStaleMessages();

    // Assert
    expect(deleted).toBe(1);
    const db = getDb();
    const msgs = db.query<{ id: string }, []>(`SELECT id FROM messages`).all();
    expect(msgs).toHaveLength(0);
  });

  test("pending メッセージはTTL超過でも削除しない", () => {
    // Arrange
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    insertTestSession("sender");
    insertTestSession("receiver");
    insertTestMessage("msg-pending", {
      from: "sender",
      to: "receiver",
      timestamp: staleTime,
      status: "pending",
    });

    // Act
    cleanStaleMessages();

    // Assert: pending は TTL による削除対象外
    const db = getDb();
    const msgs = db.query<{ id: string }, []>(`SELECT id FROM messages`).all();
    expect(msgs).toHaveLength(1);
  });

  test("宛先セッション消失時にpendingメッセージを削除する", () => {
    // Arrange: receiver セッションなし → ゾンビメッセージ
    insertTestSession("sender");
    insertTestMessage("msg-zombie", {
      from: "sender",
      to: "ghost-session",
      status: "pending",
    });

    // Act
    cleanStaleMessages();

    // Assert
    const db = getDb();
    const msgs = db.query<{ id: string }, []>(`SELECT id FROM messages`).all();
    expect(msgs).toHaveLength(0);
  });

  test("broadcast宛メッセージは宛先チェック対象外", () => {
    // Arrange: to='*' のメッセージ → 宛先なしでも削除されない
    insertTestSession("sender");
    insertTestMessage("msg-broadcast", {
      from: "sender",
      to: "*",
      type: "broadcast",
      status: "pending",
    });

    // Act
    cleanStaleMessages();

    // Assert
    const db = getDb();
    const msgs = db.query<{ id: string }, []>(`SELECT id FROM messages`).all();
    expect(msgs).toHaveLength(1);
  });

  test("孤立したbroadcast_deliveriesを削除する", () => {
    // Arrange: メッセージなしの broadcast_deliveries レコード
    const db = getDb();
    db.run(
      `INSERT INTO broadcast_deliveries (message_id, session_name) VALUES ('orphan-msg', 'some-session')`
    );

    // Act
    cleanStaleMessages();

    // Assert
    const rows = db
      .query<{ message_id: string }, []>(`SELECT * FROM broadcast_deliveries`)
      .all();
    expect(rows).toHaveLength(0);
  });

  test("削除件数を正しく返す", () => {
    // Arrange: TTL超過の delivered メッセージ3件
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    insertTestSession("a");
    insertTestSession("b");
    insertTestMessage("m1", { from: "a", to: "b", timestamp: staleTime, status: "delivered" });
    insertTestMessage("m2", { from: "a", to: "b", timestamp: staleTime, status: "acknowledged" });
    insertTestMessage("m3", { from: "a", to: "b", timestamp: staleTime, status: "delivered" });

    // Act
    const deleted = cleanStaleMessages();

    // Assert
    expect(deleted).toBe(3);
  });
});

// ─────────────────────────────────────────────
// resolveCurrentSession
// ─────────────────────────────────────────────

describe("resolveCurrentSession", () => {
  test("セット済みセッション名がDBに存在すればそれを返す", () => {
    // Arrange
    insertTestSession("my-session");
    setCurrentSessionName("my-session");

    // Act
    const result = resolveCurrentSession();

    // Assert
    expect(result).toBe("my-session");
  });

  test("セット済みだがDB消失ならnullリセットしフォールバック", () => {
    // Arrange: DB にセッションなし
    setCurrentSessionName("ghost-session");

    // Act
    const result = resolveCurrentSession();

    // Assert: フォールバックも見つからなければ null
    expect(result).toBeNull();
  });

  test("どの候補もDBになければnullを返す", () => {
    // Arrange: 何もセットしない
    setCurrentSessionName(null);

    // Act
    const result = resolveCurrentSession();

    // Assert
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────
// auditLog / cleanStaleAuditLogs
// ─────────────────────────────────────────────

describe("auditLog / cleanStaleAuditLogs", () => {
  test("監査ログを記録する", () => {
    // Act
    auditLog("test_action", "test-session", { key: "value" });

    // Assert
    const db = getDb();
    const logs = db
      .query<{ action: string; session: string; details: string }, []>(
        `SELECT action, session, details FROM audit_log`
      )
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("test_action");
    expect(logs[0].session).toBe("test-session");
    expect(JSON.parse(logs[0].details)).toEqual({ key: "value" });
  });

  test("7日超過ログを削除する", () => {
    // Arrange: 8日前のログを直接挿入
    const db = getDb();
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO audit_log (action, session, details, timestamp) VALUES ('old', 'old-session', '{}', ?)`,
      [oldTime]
    );
    auditLog("recent", "new-session", {}); // 今のログ

    // Act
    cleanStaleAuditLogs();

    // Assert
    const logs = db
      .query<{ action: string }, []>(`SELECT action FROM audit_log`)
      .all();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("recent");
  });
});

// ─────────────────────────────────────────────
// touchSession
// ─────────────────────────────────────────────

describe("touchSession", () => {
  test("last_seenを更新する", () => {
    // Arrange: 古い last_seen を持つセッション
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertTestSession("touch-me", { last_seen: oldTime });

    // Act
    const beforeTouch = new Date().toISOString();
    touchSession("touch-me");

    // Assert
    const db = getDb();
    const session = db
      .query<{ last_seen: string }, [string]>(
        `SELECT last_seen FROM sessions WHERE name = ?`
      )
      .get("touch-me");
    expect(session!.last_seen >= beforeTouch).toBe(true);
  });
});
