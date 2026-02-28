import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "./types.js";
import { isTmuxPaneAlive, clearTmuxCache } from "./tmux.js";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const STORE_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".cache",
  "ccwire"
);
const DB_PATH = join(STORE_DIR, "ccwire.db");

// Session TTL: 10 minutes (heartbeat-based zombie mitigation, #15)
const SESSION_TTL_MS = 10 * 60 * 1000;

const AUDIT_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─────────────────────────────────────────────
// Shared state (module-private)
// ─────────────────────────────────────────────

let db: Database;
let currentSessionName: string | null = null;

// ─────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────

export async function initDb(dbPath?: string): Promise<void> {
  if (!dbPath) {
    await mkdir(STORE_DIR, { recursive: true });
  }

  db = new Database(dbPath ?? DB_PATH);
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY,
      tmux_target TEXT,
      pid INTEGER,
      broadcast_cursor TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'done')),
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);

  // マイグレーション: 既存 DB にカラムがない場合は追加
  try { db.run(`ALTER TABLE sessions ADD COLUMN pid INTEGER`); } catch { /* already exists */ }
  try { db.run(`ALTER TABLE sessions ADD COLUMN broadcast_cursor TEXT`); } catch { /* already exists */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      reply_to TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'acknowledged'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      session TEXT,
      details TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  // マイグレーション: broadcast_deliveries テーブルが残っていれば削除 (#14)
  db.run(`DROP TABLE IF EXISTS broadcast_deliveries`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages("to", status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`);
}

// ─────────────────────────────────────────────
// State accessors
// ─────────────────────────────────────────────

export function getDb(): Database {
  return db;
}

export function getCurrentSessionName(): string | null {
  return currentSessionName;
}

export function setCurrentSessionName(name: string | null): void {
  currentSessionName = name;
}

// ─────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────

export function auditLog(action: string, session: string | null, details: Record<string, unknown>): void {
  db.run(
    `INSERT INTO audit_log (action, session, details, timestamp) VALUES (?, ?, ?, ?)`,
    [action, session, JSON.stringify(details), new Date().toISOString()]
  );
}

export function cleanStaleAuditLogs(): void {
  const cutoff = new Date(Date.now() - AUDIT_LOG_TTL_MS).toISOString();
  db.run(`DELETE FROM audit_log WHERE timestamp < ?`, [cutoff]);
}

// ─────────────────────────────────────────────
// Session cleanup
// ─────────────────────────────────────────────

/**
 * PID が生存しているかチェックする（tmux 非依存）。
 * kill(pid, 0) はシグナルを送らず、プロセスの存在のみ確認する。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * cleanStaleSessions: ゾンビセッションの削除
 * @param fullCheck true: キャッシュ無視でフルチェック (wire_sessions, wire_register 用)
 *
 * 3層のゾンビ検知:
 * 1. TTL ベース: last_seen が SESSION_TTL_MS を超えたセッションを削除
 * 2. PID ライブネス: pid が記録されていればプロセス生存を確認 (#15)
 * 3. tmux ライブネス: tmux_target があればペイン生存を確認
 */
export function cleanStaleSessions(fullCheck = false): void {
  // 1. TTL-based cleanup
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  db.run(`DELETE FROM sessions WHERE last_seen < ?`, [cutoff]);

  // 2. PID liveness check: pid が記録されたセッションはプロセス生存を確認 (#15)
  const pidSessions = db.query<Session, []>(
    `SELECT * FROM sessions WHERE pid IS NOT NULL`
  ).all();

  for (const s of pidSessions) {
    if (!isPidAlive(s.pid!)) {
      db.run(`DELETE FROM sessions WHERE name = ?`, [s.name]);
      if (s.tmux_target) clearTmuxCache(s.tmux_target);
      auditLog("auto_cleanup", s.name, { reason: "pid_dead", pid: s.pid });
    }
  }

  // 3. tmux liveness check: tmux_target があり、まだ残っているセッションのペイン生存を確認
  const tmuxSessions = db.query<Session, []>(
    `SELECT * FROM sessions WHERE tmux_target IS NOT NULL`
  ).all();

  for (const s of tmuxSessions) {
    if (!isTmuxPaneAlive(s.tmux_target!, !fullCheck)) {
      db.run(`DELETE FROM sessions WHERE name = ?`, [s.name]);
      clearTmuxCache(s.tmux_target!);
      auditLog("auto_cleanup", s.name, { reason: "tmux_pane_dead", tmux_target: s.tmux_target });
    }
  }
}

// ─────────────────────────────────────────────
// Message cleanup
// ─────────────────────────────────────────────

export function cleanStaleMessages(): number {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();

  // Delete non-pending messages older than TTL
  const result = db.run(
    `DELETE FROM messages WHERE timestamp < ? AND status != 'pending'`,
    [cutoff]
  );

  // Zombie メッセージ: 宛先セッションが消失した pending メッセージを削除 (Issue #5)
  db.run(
    `DELETE FROM messages WHERE status = 'pending' AND "to" != '*'
     AND "to" NOT IN (SELECT name FROM sessions)`
  );

  return result.changes;
}

// ─────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────

export function touchSession(name: string): void {
  db.run(`UPDATE sessions SET last_seen = ? WHERE name = ?`, [new Date().toISOString(), name]);
}

/**
 * currentSessionName を自動復元する。
 * フォールバック: 環境変数 CCWIRE_SESSION_NAME → tmux セッション名 → cwd basename
 * DB に該当セッションが存在すればそれを使う。
 */
export function resolveCurrentSession(): string | null {
  if (currentSessionName) {
    // DB に存在するか確認（セッションが消えていたらリセット）
    const exists = db.query<{ name: string }, [string]>(
      `SELECT name FROM sessions WHERE name = ?`
    ).get(currentSessionName);
    if (exists) return currentSessionName;
    currentSessionName = null;
  }

  // フォールバックチェーン
  const candidates: string[] = [];

  // 1. 環境変数
  const envName = process.env.CCWIRE_SESSION_NAME;
  if (envName) candidates.push(envName);

  // 2. tmux セッション名
  try {
    const result = Bun.spawnSync(["tmux", "display-message", "-p", "#S"]);
    if (result.exitCode === 0) {
      const tmuxName = result.stdout.toString().trim();
      if (tmuxName) candidates.push(tmuxName);
    }
  } catch { /* tmux not available */ }

  // 3. cwd ベースネーム
  const cwdName = process.env.CLAUDE_PROJECT_DIR
    ? process.env.CLAUDE_PROJECT_DIR.split("/").pop()!
    : process.cwd().split("/").pop()!;
  if (cwdName) candidates.push(cwdName);

  // DB で最初にマッチするものを採用
  for (const name of candidates) {
    const session = db.query<{ name: string }, [string]>(
      `SELECT name FROM sessions WHERE name = ?`
    ).get(name);
    if (session) {
      currentSessionName = session.name;
      return currentSessionName;
    }
  }

  return null;
}
