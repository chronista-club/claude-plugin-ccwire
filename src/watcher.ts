import { watch, type FSWatcher } from "node:fs";
import { getDb, getCurrentSessionName, STORE_DIR } from "./db.js";
import { notifyViaTmux } from "./tmux.js";
import type { Session } from "./types.js";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const DEBOUNCE_MS = 800;

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let debounceTimer: Timer | null = null;

// ─────────────────────────────────────────────
// Pending message check
// ─────────────────────────────────────────────

/**
 * 自セッション宛の未配信メッセージをチェックし、あれば tmux で通知する。
 * - direct message: status = 'pending' かつ to = self
 * - broadcast: self に未配信の broadcast
 */
export function checkAndNotify(): void {
  const sessionName = getCurrentSessionName();
  if (!sessionName) return;

  let db;
  try {
    db = getDb();
  } catch {
    return; // DB not yet initialized
  }

  // 1. Direct pending messages
  const direct = db.query<{ cnt: number }, [string]>(
    `SELECT COUNT(*) as cnt FROM messages WHERE "to" = ? AND status = 'pending'`
  ).get(sessionName);

  // 2. Undelivered broadcasts (not from self, not yet in broadcast_deliveries)
  const broadcast = db.query<{ cnt: number }, [string, string]>(
    `SELECT COUNT(*) as cnt FROM messages
     WHERE "to" = '*' AND "from" != ?
     AND id NOT IN (SELECT message_id FROM broadcast_deliveries WHERE session_name = ?)`
  ).get(sessionName, sessionName);

  const total = (direct?.cnt ?? 0) + (broadcast?.cnt ?? 0);
  if (total === 0) return;

  // Get own tmux target for self-notification
  const session = db.query<Session, [string]>(
    `SELECT * FROM sessions WHERE name = ?`
  ).get(sessionName);

  if (session?.tmux_target) {
    notifyViaTmux(session.tmux_target, `wire_receiveで未読メッセージを確認して`);
  }
}

// ─────────────────────────────────────────────
// Watcher lifecycle
// ─────────────────────────────────────────────

/**
 * DB ファイルの変更を監視し、自セッション宛の未読メッセージがあれば通知する。
 *
 * fs.watch で STORE_DIR を監視し、ccwire.db 関連ファイルの変更を debounce して検知。
 * WAL モードでは書き込みは ccwire.db-wal に行われるため、ディレクトリ監視で両方をカバー。
 */
export function startWatcher(): void {
  if (watcher) return; // already running

  try {
    watcher = watch(STORE_DIR, (_eventType, filename) => {
      // ccwire.db または ccwire.db-wal の変更のみ対象
      if (!filename?.startsWith("ccwire.db")) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndNotify, DEBOUNCE_MS);
    });

    watcher.on("error", (err) => {
      console.error("[ccwire watcher] fs.watch error, stopping watcher:", err);
      stopWatcher();
    });
  } catch {
    // STORE_DIR が存在しない場合は無視（initDb 前に呼ばれた場合）
  }
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
