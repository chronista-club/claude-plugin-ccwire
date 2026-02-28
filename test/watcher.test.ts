/**
 * watcher.ts 仕様化テスト
 *
 * checkAndNotify のロジックをユニットテストする。
 * fs.watch 自体は実環境依存のため、checkAndNotify を export して直接テスト。
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  setupTestDb,
  teardownTestDb,
  insertTestSession,
  insertTestMessage,
} from "./helpers/setup.js";
import { setCurrentSessionName } from "../src/db.js";

// notifyViaTmux をモック化（tmux は CI で使えない）
const mockNotify = mock(() => Promise.resolve());
mock.module("../src/tmux.js", () => ({
  notifyViaTmux: mockNotify,
  isTmuxPaneAlive: () => true,
  clearTmuxCache: () => {},
  execTmux: () => Promise.resolve({ ok: true }),
}));

// モック後に watcher を動的 import（モック適用のため）
const { checkAndNotify, stopWatcher } = await import("../src/watcher.js");

describe("checkAndNotify", () => {
  beforeEach(async () => {
    mockNotify.mockClear();
    await setupTestDb();
  });

  afterEach(() => {
    stopWatcher();
    teardownTestDb();
  });

  // ── 通知しないケース ──────────────────────

  test("セッション未登録なら通知しない", () => {
    // Arrange
    setCurrentSessionName(null);

    // Act
    checkAndNotify();

    // Assert
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test("pending メッセージがなければ通知しない", () => {
    // Arrange
    insertTestSession("self", { tmux_target: "test:1.1" });
    setCurrentSessionName("self");
    insertTestSession("other");
    insertTestMessage("msg-1", { from: "other", to: "self", status: "delivered" });

    // Act
    checkAndNotify();

    // Assert
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test("tmux_target がなければ通知しない", () => {
    // Arrange: tmux_target = null
    insertTestSession("self", { tmux_target: null });
    setCurrentSessionName("self");
    insertTestSession("other");
    insertTestMessage("msg-1", { from: "other", to: "self", status: "pending" });

    // Act
    checkAndNotify();

    // Assert
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // ── 通知するケース ────────────────────────

  test("pending direct メッセージがあれば notifyViaTmux を呼ぶ", () => {
    // Arrange
    insertTestSession("self", { tmux_target: "test:1.1" });
    setCurrentSessionName("self");
    insertTestSession("other");
    insertTestMessage("msg-1", { from: "other", to: "self", status: "pending" });

    // Act
    checkAndNotify();

    // Assert
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith("test:1.1", expect.stringContaining("wire_receive"));
  });

  test("未配信 broadcast があれば notifyViaTmux を呼ぶ", () => {
    // Arrange
    insertTestSession("self", { tmux_target: "test:1.1" });
    setCurrentSessionName("self");
    insertTestSession("other");
    insertTestMessage("msg-broadcast", { from: "other", to: "*", type: "broadcast", status: "pending" });

    // Act
    checkAndNotify();

    // Assert
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith("test:1.1", expect.stringContaining("wire_receive"));
  });

  test("自分が送った broadcast では通知しない", () => {
    // Arrange
    insertTestSession("self", { tmux_target: "test:1.1" });
    setCurrentSessionName("self");
    insertTestMessage("msg-self-broadcast", { from: "self", to: "*", type: "broadcast", status: "pending" });

    // Act
    checkAndNotify();

    // Assert
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
