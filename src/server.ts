import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Database } from "bun:sqlite";
import pkg from "../package.json";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const STORE_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".cache",
  "ccwire"
);
const DB_PATH = join(STORE_DIR, "ccwire.db");

// Session TTL: 2 hours (zombie session mitigation)
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface Session {
  name: string;
  tmux_target: string | null;
  status: "idle" | "busy" | "done";
  registered_at: string;
  last_seen: string;
}

interface MessageRow {
  id: string;
  from: string;
  to: string;
  type: string;
  content: string;
  timestamp: string;
  reply_to: string | null;
  status: string;
}

// ─────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────

let db: Database;

function initDb(): void {
  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY,
      tmux_target TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'done')),
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);

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
    CREATE TABLE IF NOT EXISTS broadcast_deliveries (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      session_name TEXT NOT NULL,
      PRIMARY KEY (message_id, session_name)
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

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages("to", status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_session ON broadcast_deliveries(session_name)`);
}

// ─────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────

const AUDIT_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function auditLog(action: string, session: string | null, details: Record<string, unknown>): void {
  db.run(
    `INSERT INTO audit_log (action, session, details, timestamp) VALUES (?, ?, ?, ?)`,
    [action, session, JSON.stringify(details), new Date().toISOString()]
  );
}

function cleanStaleAuditLogs(): void {
  const cutoff = new Date(Date.now() - AUDIT_LOG_TTL_MS).toISOString();
  db.run(`DELETE FROM audit_log WHERE timestamp < ?`, [cutoff]);
}

// tmux ライブネスチェック キャッシュ (Issue #8)
const TMUX_CACHE_TTL_MS = 30_000;
const tmuxLivenessCache = new Map<string, { alive: boolean; checkedAt: number }>();

function isTmuxPaneAlive(tmuxTarget: string, useCache = true): boolean {
  if (useCache) {
    const cached = tmuxLivenessCache.get(tmuxTarget);
    if (cached && Date.now() - cached.checkedAt < TMUX_CACHE_TTL_MS) {
      return cached.alive;
    }
  }

  let alive = false;
  try {
    const result = Bun.spawnSync(["tmux", "display-message", "-t", tmuxTarget, "-p", "#{pane_id}"]);
    alive = result.exitCode === 0;
  } catch { /* tmux not available */ }

  tmuxLivenessCache.set(tmuxTarget, { alive, checkedAt: Date.now() });
  return alive;
}

/**
 * cleanStaleSessions: ゾンビセッションの削除
 * @param fullCheck true: キャッシュ無視でフルチェック (wire_sessions, wire_register 用)
 */
function cleanStaleSessions(fullCheck = false): void {
  // TTL-based cleanup
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  db.run(`DELETE FROM sessions WHERE last_seen < ?`, [cutoff]);

  // tmux liveness check: tmux_target があるセッションはペイン生存を確認
  const tmuxSessions = db.query<Session, []>(
    `SELECT * FROM sessions WHERE tmux_target IS NOT NULL`
  ).all();

  for (const s of tmuxSessions) {
    if (!isTmuxPaneAlive(s.tmux_target!, !fullCheck)) {
      db.run(`DELETE FROM sessions WHERE name = ?`, [s.name]);
      tmuxLivenessCache.delete(s.tmux_target!);
      auditLog("auto_cleanup", s.name, { reason: "tmux_pane_dead", tmux_target: s.tmux_target });
    }
  }
}

function cleanStaleMessages(): number {
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

  // broadcast_deliveries の TTL クリーンアップ: 対応メッセージが存在しないレコードを削除 (Issue #5)
  db.run(
    `DELETE FROM broadcast_deliveries WHERE message_id NOT IN (SELECT id FROM messages)`
  );

  return result.changes;
}

function touchSession(name: string): void {
  db.run(`UPDATE sessions SET last_seen = ? WHERE name = ?`, [new Date().toISOString(), name]);
}

// ─────────────────────────────────────────────
// tmux notification helper
// ─────────────────────────────────────────────

const TMUX_TIMEOUT_MS = 5_000;

function execTmux(...args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS }, (err) => {
      if (err) {
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

async function notifyViaTmux(tmuxTarget: string, message: string): Promise<void> {
  await execTmux("send-keys", "-t", tmuxTarget, message);
  await Bun.sleep(500);
  await execTmux("send-keys", "-t", tmuxTarget, "Enter");
}

// ─────────────────────────────────────────────
// In-memory session name for this MCP process
// ─────────────────────────────────────────────

let currentSessionName: string | null = null;

/**
 * currentSessionName を自動復元する。
 * フォールバック: 環境変数 CCWIRE_SESSION_NAME → tmux セッション名 → cwd basename
 * DB に該当セッションが存在すればそれを使う。
 */
function resolveCurrentSession(): string | null {
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

// ─────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────

const server = new McpServer({
  name: "ccwire",
  version: pkg.version,
});

// ── wire_register ───────────────────────────

server.registerTool("wire_register", {
  title: "Wire Register",
  description: "セッションを登録する。名前は自由に付けられる（例: 'nexus-main', 'issue-2'）。登録するとメッセージの送受信が可能になる。",
  inputSchema: {
    name: z.string().describe("セッション名（例: 'nexus-main', 'issue-2'）"),
    tmux_target: z.string().optional().describe("tmuxターゲット（例: 'session:window.pane'）。省略可。"),
  },
}, async ({ name, tmux_target }) => {
  // tmux_target のバリデーション（指定時のみ）
  let validatedTmuxTarget = tmux_target ?? null;
  let tmuxWarning: string | null = null;

  if (tmux_target) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("tmux", ["display-message", "-t", tmux_target, "-p", "#{pane_id}"], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      tmuxWarning = `警告: tmux_target "${tmux_target}" のペインが見つかりません。通知機能は無効です。`;
      validatedTmuxTarget = null;
    }
  }

  cleanStaleSessions(true); // フルチェック

  const now = new Date().toISOString();
  const existing = db.query<{ registered_at: string }, [string]>(
    `SELECT registered_at FROM sessions WHERE name = ?`
  ).get(name);

  db.run(
    `INSERT OR REPLACE INTO sessions (name, tmux_target, status, registered_at, last_seen)
     VALUES (?, ?, 'idle', ?, ?)`,
    [name, validatedTmuxTarget, existing?.registered_at ?? now, now]
  );

  currentSessionName = name;

  auditLog("register", name, { tmux_target: validatedTmuxTarget });

  const count = db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM sessions`).get()!.cnt;

  const message = tmuxWarning
    ? `セッション "${name}" を登録しました。\n\n${tmuxWarning}\n\n現在の接続セッション数: ${count}`
    : `セッション "${name}" を登録しました。\n\n現在の接続セッション数: ${count}`;

  return {
    content: [{ type: "text" as const, text: message }],
  };
});

// ── wire_send ───────────────────────────────

server.registerTool("wire_send", {
  title: "Wire Send",
  description: "特定のセッションにメッセージを送信する。",
  inputSchema: {
    to: z.string().describe("送信先セッション名"),
    content: z.string().describe("メッセージ内容"),
    type: z.enum(["task_request", "response", "status_update", "question", "health_ping", "conflict_warning"]).default("task_request").describe("メッセージタイプ"),
    reply_to: z.string().nullable().default(null).describe("返信先メッセージID（返信の場合）"),
  },
}, async ({ to, content, type, reply_to }) => {
  const sender = resolveCurrentSession();
  if (!sender) {
    return {
      content: [{ type: "text" as const, text: "エラー: セッションが見つかりません。wire_register で登録してください。" }],
      isError: true,
    };
  }

  cleanStaleSessions();

  const target = db.query<Session, [string]>(`SELECT * FROM sessions WHERE name = ?`).get(to);
  if (!target) {
    const rows = db.query<{ name: string }, []>(`SELECT name FROM sessions`).all();
    const available = rows.map(r => r.name).join(", ");
    return {
      content: [{ type: "text" as const, text: `エラー: セッション "${to}" が見つかりません。\n利用可能: ${available || "(なし)"}` }],
      isError: true,
    };
  }

  touchSession(sender);

  const msgId = `msg-${randomUUID()}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [msgId, sender, to, type, content, now, reply_to ?? null]
  );

  // Auto-notify via tmux
  if (target.tmux_target) {
    await notifyViaTmux(target.tmux_target, `wire_receiveで未読メッセージを確認して`);
  }

  auditLog("send", sender, { to, type, message_id: msgId });

  return {
    content: [{
      type: "text" as const,
      text: `メッセージ送信完了\n  ID: ${msgId}\n  To: ${to}\n  Type: ${type}`,
    }],
  };
});

// ── wire_receive ────────────────────────────

server.registerTool("wire_receive", {
  title: "Wire Receive",
  description: "自分宛の未読メッセージを取得する。",
  inputSchema: {
    limit: z.number().default(10).describe("取得するメッセージの最大数"),
  },
}, async ({ limit }) => {
  const receiver = resolveCurrentSession();
  if (!receiver) {
    return {
      content: [{ type: "text" as const, text: "エラー: セッションが見つかりません。wire_register で登録してください。" }],
      isError: true,
    };
  }

  touchSession(receiver);

  // トランザクションで SELECT → UPDATE をアトミックに実行 (Issue #5)
  const allMessages = db.transaction(() => {
    const messages = db.query<MessageRow, [string, string, string, number]>(
      `SELECT * FROM messages
       WHERE ("to" = ? AND status = 'pending')
          OR ("to" = '*' AND "from" != ?
              AND id NOT IN (SELECT message_id FROM broadcast_deliveries WHERE session_name = ?))
       ORDER BY timestamp ASC
       LIMIT ?`
    ).all(receiver, receiver, receiver, limit);

    for (const msg of messages) {
      if (msg.to === "*") {
        db.run(
          `INSERT OR IGNORE INTO broadcast_deliveries (message_id, session_name) VALUES (?, ?)`,
          [msg.id, receiver]
        );
      } else {
        db.run(`UPDATE messages SET status = 'delivered' WHERE id = ?`, [msg.id]);
      }
    }

    return messages;
  })();

  auditLog("receive", receiver, { count: allMessages.length });

  if (allMessages.length === 0) {
    return {
      content: [{ type: "text" as const, text: "未読メッセージはありません。" }],
    };
  }

  const formatted = allMessages.map((msg, i) => {
    const replyInfo = msg.reply_to ? `  Reply-To: ${msg.reply_to}\n` : "";
    return `[${i + 1}] ${msg.id}\n  From: ${msg.from}\n  Type: ${msg.type}\n  Time: ${msg.timestamp}\n${replyInfo}  Content: ${msg.content}`;
  }).join("\n\n");

  return {
    content: [{
      type: "text" as const,
      text: `未読メッセージ ${allMessages.length}件:\n\n${formatted}`,
    }],
  };
});

// ── wire_broadcast ──────────────────────────

server.registerTool("wire_broadcast", {
  title: "Wire Broadcast",
  description: "全セッションに一斉メッセージを送信する。",
  inputSchema: {
    content: z.string().describe("ブロードキャストメッセージ内容"),
  },
}, async ({ content }) => {
  const sender = resolveCurrentSession();
  if (!sender) {
    return {
      content: [{ type: "text" as const, text: "エラー: セッションが見つかりません。wire_register で登録してください。" }],
      isError: true,
    };
  }

  cleanStaleSessions();
  touchSession(sender);

  const msgId = `msg-${randomUUID()}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO messages (id, "from", "to", type, content, timestamp, reply_to, status)
     VALUES (?, ?, '*', 'broadcast', ?, ?, NULL, 'pending')`,
    [msgId, sender, content, now]
  );

  // Auto-notify all sessions with tmux_target
  const recipients = db.query<Session, [string]>(
    `SELECT * FROM sessions WHERE name != ? AND tmux_target IS NOT NULL`
  ).all(sender);

  for (const s of recipients) {
    await notifyViaTmux(s.tmux_target!, `wire_receiveで未読メッセージを確認して`);
  }

  const recipientCount = db.query<{ cnt: number }, [string]>(
    `SELECT COUNT(*) as cnt FROM sessions WHERE name != ?`
  ).get(sender)!.cnt;

  auditLog("broadcast", sender, { message_id: msgId, recipient_count: recipientCount });

  return {
    content: [{
      type: "text" as const,
      text: `ブロードキャスト送信完了\n  ID: ${msgId}\n  対象セッション数: ${recipientCount}`,
    }],
  };
});

// ── wire_sessions ───────────────────────────

server.registerTool("wire_sessions", {
  title: "Wire Sessions",
  description: "接続中のセッション一覧を取得する。",
  inputSchema: {},
}, async () => {
  cleanStaleSessions(true); // フルチェック
  const cleanedMsgs = cleanStaleMessages();
  cleanStaleAuditLogs();

  const self = resolveCurrentSession();
  const sessions = db.query<Session, []>(`SELECT * FROM sessions`).all();

  if (sessions.length === 0) {
    return {
      content: [{ type: "text" as const, text: "登録されたセッションはありません。" }],
    };
  }

  const lines = sessions.map((s) => {
    const isSelf = s.name === self ? " (自分)" : "";
    const tmux = s.tmux_target ? ` [tmux: ${s.tmux_target}]` : "";
    return `  ${s.name}${isSelf} - ${s.status}${tmux} (last: ${s.last_seen})`;
  });

  const cleanInfo = cleanedMsgs > 0 ? `\n(${cleanedMsgs} 件の古いメッセージを削除)` : "";

  return {
    content: [{
      type: "text" as const,
      text: `接続セッション (${sessions.length}):\n${lines.join("\n")}${cleanInfo}`,
    }],
  };
});

// ── wire_status ─────────────────────────────

server.registerTool("wire_status", {
  title: "Wire Status",
  description: "自分のステータスを更新する、または全体のステータスを取得する。",
  inputSchema: {
    status: z.enum(["idle", "busy", "done"]).optional().describe("設定するステータス。省略すると全体のステータスを取得。"),
  },
}, async ({ status }) => {
  cleanStaleSessions();

  if (status) {
    const self = resolveCurrentSession();
    if (!self) {
      return {
        content: [{ type: "text" as const, text: "エラー: セッションが見つかりません。wire_register で登録してください。" }],
        isError: true,
      };
    }

    db.run(
      `UPDATE sessions SET status = ?, last_seen = ? WHERE name = ?`,
      [status, new Date().toISOString(), self]
    );

    return {
      content: [{
        type: "text" as const,
        text: `ステータスを "${status}" に更新しました。`,
      }],
    };
  }

  // Return all statuses
  const self = resolveCurrentSession();
  const sessions = db.query<Session, []>(`SELECT * FROM sessions`).all();
  const lines = sessions.map((s) => {
    const isSelf = s.name === self ? " ★" : "";
    return `  ${s.name}: ${s.status}${isSelf}`;
  });

  return {
    content: [{
      type: "text" as const,
      text: `全セッションステータス:\n${lines.join("\n")}`,
    }],
  };
});

// ── wire_unregister ──────────────────────────

server.registerTool("wire_unregister", {
  title: "Wire Unregister",
  description: "セッションの登録を解除する。省略時は自分自身を解除する。",
  inputSchema: {
    name: z.string().optional().describe("解除するセッション名。省略時は自分自身。"),
  },
}, async ({ name }) => {
  const self = resolveCurrentSession();
  const targetName = name ?? self;

  if (!targetName) {
    return {
      content: [{ type: "text" as const, text: "エラー: セッション名を指定するか、先に wire_register で登録してください。" }],
      isError: true,
    };
  }

  // 認可チェック: 他セッションの削除は拒否 (Issue #3)
  if (self && targetName !== self) {
    return {
      content: [{ type: "text" as const, text: `エラー: 他セッション "${targetName}" の登録解除はできません。自分自身のセッションのみ解除可能です。` }],
      isError: true,
    };
  }

  const existing = db.query<Session, [string]>(`SELECT * FROM sessions WHERE name = ?`).get(targetName);
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `エラー: セッション "${targetName}" は登録されていません。` }],
      isError: true,
    };
  }

  db.run(`DELETE FROM sessions WHERE name = ?`, [targetName]);

  if (targetName === currentSessionName) {
    currentSessionName = null;
  }

  const remaining = db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM sessions`).get()!.cnt;

  return {
    content: [{
      type: "text" as const,
      text: `セッション "${targetName}" の登録を解除しました。\n残りセッション数: ${remaining}`,
    }],
  };
});

// ── wire_ack ────────────────────────────────

server.registerTool("wire_ack", {
  title: "Wire Acknowledge",
  description: "メッセージの受信確認を送る。",
  inputSchema: {
    message_id: z.string().describe("確認するメッセージID"),
  },
}, async ({ message_id }) => {
  const self = resolveCurrentSession();
  if (!self) {
    return {
      content: [{ type: "text" as const, text: "エラー: セッションが見つかりません。wire_register で登録してください。" }],
      isError: true,
    };
  }

  const msg = db.query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`).get(message_id);
  if (!msg) {
    return {
      content: [{ type: "text" as const, text: `エラー: メッセージ "${message_id}" が見つかりません。` }],
      isError: true,
    };
  }

  // 認可チェック: 自分宛 or 自分発のメッセージのみ ack 可能 (Issue #3)
  if (msg.to !== self && msg.to !== "*" && msg.from !== self) {
    return {
      content: [{ type: "text" as const, text: `エラー: メッセージ "${message_id}" は自分宛でも自分発でもないため、確認できません。` }],
      isError: true,
    };
  }

  db.run(`UPDATE messages SET status = 'acknowledged' WHERE id = ?`, [message_id]);

  return {
    content: [{
      type: "text" as const,
      text: `メッセージ "${message_id}" を確認済みにしました。`,
    }],
  };
});

// ── wire_thread ────────────────────────────────

server.registerTool("wire_thread", {
  title: "Wire Thread",
  description: "メッセージIDからスレッド（reply_toチェーン）全体を取得する。どのメッセージIDを指定しても、そのスレッドの先頭から末尾まで時系列で返す。",
  inputSchema: {
    message_id: z.string().describe("スレッド内の任意のメッセージID"),
  },
}, async ({ message_id }) => {
  const THREAD_DEPTH_LIMIT = 100;

  // Find the root of the thread by tracing reply_to chain upward (Issue #7: UNION + depth limit)
  const rootRow = db.query<{ id: string }, [string, number]>(`
    WITH RECURSIVE ancestors(id, reply_to, depth) AS (
      SELECT id, reply_to, 0 FROM messages WHERE id = ?
      UNION
      SELECT m.id, m.reply_to, a.depth + 1 FROM messages m
      JOIN ancestors a ON m.id = a.reply_to
      WHERE a.depth < ?
    )
    SELECT id FROM ancestors WHERE reply_to IS NULL LIMIT 1
  `).get(message_id, THREAD_DEPTH_LIMIT);

  if (!rootRow) {
    return {
      content: [{ type: "text" as const, text: `エラー: メッセージ "${message_id}" が見つからないか、スレッドを構築できません。` }],
      isError: true,
    };
  }

  // Collect all descendants from the root (Issue #7: UNION + depth limit + LIMIT)
  const thread = db.query<MessageRow, [string, number]>(`
    WITH RECURSIVE thread(id, depth) AS (
      SELECT id, 0 FROM messages WHERE id = ?
      UNION
      SELECT m.id, t.depth + 1 FROM messages m
      JOIN thread t ON m.reply_to = t.id
      WHERE t.depth < ?
    )
    SELECT msg.* FROM messages msg
    JOIN thread t ON msg.id = t.id
    ORDER BY msg.timestamp ASC
    LIMIT 500
  `).all(rootRow.id, THREAD_DEPTH_LIMIT);

  if (thread.length === 0) {
    return {
      content: [{ type: "text" as const, text: `エラー: メッセージ "${message_id}" が見つからないか、スレッドを構築できません。` }],
      isError: true,
    };
  }

  const formatted = thread.map((msg, i) => {
    const truncated = msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content;
    return `[${i + 1}] ${msg.from} (${msg.type})\n    ${msg.timestamp}\n    ${truncated}`;
  }).join("\n\n");

  const rootId = thread[0].id;

  return {
    content: [{
      type: "text" as const,
      text: `スレッド (${thread.length} messages, root: ${rootId}):\n\n${formatted}`,
    }],
  };
});

// ── wire_control ────────────────────────────────

server.registerTool("wire_control", {
  title: "Wire Control",
  description: "セッションの tmux ペインにキーストロークを送信する。止まっている worker を起こしたり、Permission prompt に応答したり、テキストを入力できる。",
  inputSchema: {
    session: z.string().describe("対象セッション名"),
    action: z.enum(["enter", "accept", "reject", "interrupt", "text"])
      .describe("アクション: enter=Enter送信, accept=y+Enter, reject=n+Enter, interrupt=Ctrl+C, text=テキスト入力+Enter"),
    text: z.string().optional().describe("action='text' の場合に送信するテキスト"),
  },
}, async ({ session, action, text }) => {
  cleanStaleSessions();

  const target = db.query<Session, [string]>(`SELECT * FROM sessions WHERE name = ?`).get(session);

  if (!target) {
    const rows = db.query<{ name: string }, []>(`SELECT name FROM sessions`).all();
    const available = rows.map(r => r.name).join(", ");
    return {
      content: [{ type: "text" as const, text: `エラー: セッション "${session}" が見つかりません。\n利用可能: ${available || "(なし)"}` }],
      isError: true,
    };
  }

  if (!target.tmux_target) {
    return {
      content: [{ type: "text" as const, text: `エラー: セッション "${session}" に tmux_target が設定されていません。wire_register で tmux_target を指定して再登録してください。` }],
      isError: true,
    };
  }

  if (action === "text" && (!text || text.length === 0)) {
    return {
      content: [{ type: "text" as const, text: `エラー: action="text" の場合は空でない text パラメータが必須です。` }],
      isError: true,
    };
  }

  const tmux = target.tmux_target;

  switch (action) {
    case "enter":
      await execTmux("send-keys", "-t", tmux, "Enter");
      break;
    case "accept":
      await execTmux("send-keys", "-t", tmux, "y");
      await Bun.sleep(100);
      await execTmux("send-keys", "-t", tmux, "Enter");
      break;
    case "reject":
      await execTmux("send-keys", "-t", tmux, "n");
      await Bun.sleep(100);
      await execTmux("send-keys", "-t", tmux, "Enter");
      break;
    case "interrupt":
      await execTmux("send-keys", "-t", tmux, "C-c");
      break;
    case "text":
      // -l: リテラルモードで送信（特殊キー解釈を防止）(Issue #4)
      await execTmux("send-keys", "-t", tmux, "-l", text!);
      await Bun.sleep(100);
      await execTmux("send-keys", "-t", tmux, "Enter");
      break;
  }

  auditLog("control", resolveCurrentSession(), {
    target_session: session,
    control_action: action,
    text: text ?? null,
  });

  const actionDesc: Record<string, string> = {
    enter: "Enter キー送信",
    accept: "承認 (y + Enter)",
    reject: "拒否 (n + Enter)",
    interrupt: "中断 (Ctrl+C)",
    text: `テキスト入力: "${text}"`,
  };

  return {
    content: [{
      type: "text" as const,
      text: `制御コマンド送信完了\n  対象: ${session} [${tmux}]\n  アクション: ${actionDesc[action]}`,
    }],
  };
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

async function main() {
  await mkdir(STORE_DIR, { recursive: true });
  initDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ccwire server error:", err);
  process.exit(1);
});
