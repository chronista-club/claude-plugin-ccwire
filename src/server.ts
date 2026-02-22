import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile, readdir, unlink, stat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const STORE_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".cache",
  "ccwire"
);
const SESSIONS_FILE = join(STORE_DIR, "sessions.json");
const MESSAGES_DIR = join(STORE_DIR, "messages");
const LOCK_FILE = join(STORE_DIR, "lock");

// Session TTL: 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface Session {
  name: string;
  tmux_target?: string;
  status: "idle" | "busy" | "done";
  registered_at: string;
  last_seen: string;
}

interface Sessions {
  [name: string]: Session;
}

interface Message {
  id: string;
  from: string;
  to: string;
  type: "task_request" | "response" | "broadcast" | "ack" | "status_update";
  content: string;
  timestamp: string;
  reply_to: string | null;
  status: "pending" | "delivered" | "acknowledged";
  delivered_to?: string[];
}

// ─────────────────────────────────────────────
// File-based store helpers
// ─────────────────────────────────────────────

async function ensureStore(): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  await mkdir(MESSAGES_DIR, { recursive: true });
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = LOCK_FILE;
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        return await fn();
      } finally {
        await rmdir(lockDir).catch(() => {});
      }
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const lockStat = await stat(lockDir);
          if (Date.now() - lockStat.mtimeMs > 10_000) {
            await rmdir(lockDir).catch(() => {});
            continue;
          }
        } catch {}
        await Bun.sleep(retryDelay);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Could not acquire file lock");
}

async function readSessions(): Promise<Sessions> {
  try {
    const data = await readFile(SESSIONS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeSessions(sessions: Sessions): Promise<void> {
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

async function ensureSessionDir(name: string): Promise<string> {
  const dir = join(MESSAGES_DIR, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeMessage(msg: Message): Promise<void> {
  const dir = msg.to === "*"
    ? join(MESSAGES_DIR, "broadcast")
    : join(MESSAGES_DIR, msg.to);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${msg.id}.json`), JSON.stringify(msg, null, 2));
}

async function readMessages(sessionName: string, limit: number): Promise<Message[]> {
  const messages: Message[] = [];

  // Read direct messages
  const directDir = join(MESSAGES_DIR, sessionName);
  try {
    const files = await readdir(directDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const data = await readFile(join(directDir, file), "utf-8");
      const msg: Message = JSON.parse(data);
      if (msg.status === "pending") {
        messages.push(msg);
      }
    }
  } catch {}

  // Read broadcast messages (per-session delivery tracking)
  const broadcastDir = join(MESSAGES_DIR, "broadcast");
  try {
    const files = await readdir(broadcastDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const data = await readFile(join(broadcastDir, file), "utf-8");
      const msg: Message = JSON.parse(data);
      if (msg.from !== sessionName && !(msg.delivered_to?.includes(sessionName))) {
        messages.push(msg);
      }
    }
  } catch {}

  // Sort by timestamp (oldest first)
  messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return messages.slice(0, limit);
}

async function markMessageDelivered(msg: Message, sessionName: string): Promise<void> {
  if (msg.to === "*") {
    // Broadcast: per-session delivery tracking
    if (!msg.delivered_to) msg.delivered_to = [];
    if (!msg.delivered_to.includes(sessionName)) {
      msg.delivered_to.push(sessionName);
    }
    // Mark as fully delivered only when all active sessions have received it
    const sessions = cleanStaleSessions(await readSessions());
    const recipients = Object.keys(sessions).filter(n => n !== msg.from);
    if (recipients.length > 0 && recipients.every(n => msg.delivered_to!.includes(n))) {
      msg.status = "delivered";
    }
  } else {
    // Direct message: immediate delivery
    msg.status = "delivered";
  }
  const dir = msg.to === "*"
    ? join(MESSAGES_DIR, "broadcast")
    : join(MESSAGES_DIR, msg.to);
  await writeFile(join(dir, `${msg.id}.json`), JSON.stringify(msg, null, 2));
}

async function acknowledgeMessage(messageId: string, sessionName: string): Promise<boolean> {
  // Search in session's direct messages
  const directDir = join(MESSAGES_DIR, sessionName);
  try {
    const filePath = join(directDir, `${messageId}.json`);
    const data = await readFile(filePath, "utf-8");
    const msg: Message = JSON.parse(data);
    msg.status = "acknowledged";
    await writeFile(filePath, JSON.stringify(msg, null, 2));
    return true;
  } catch {}

  // Search in broadcast
  const broadcastDir = join(MESSAGES_DIR, "broadcast");
  try {
    const filePath = join(broadcastDir, `${messageId}.json`);
    const data = await readFile(filePath, "utf-8");
    const msg: Message = JSON.parse(data);
    msg.status = "acknowledged";
    await writeFile(filePath, JSON.stringify(msg, null, 2));
    return true;
  } catch {}

  return false;
}

async function findMessageById(messageId: string): Promise<Message | null> {
  try {
    const dirs = await readdir(MESSAGES_DIR);
    for (const dir of dirs) {
      const filePath = join(MESSAGES_DIR, dir, `${messageId}.json`);
      try {
        const data = await readFile(filePath, "utf-8");
        return JSON.parse(data);
      } catch {}
    }
  } catch {}
  return null;
}

async function getAllMessages(): Promise<Message[]> {
  const messages: Message[] = [];
  try {
    const dirs = await readdir(MESSAGES_DIR);
    for (const dir of dirs) {
      const dirPath = join(MESSAGES_DIR, dir);
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          try {
            const data = await readFile(join(dirPath, file), "utf-8");
            messages.push(JSON.parse(data));
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return messages;
}

async function buildThread(messageId: string): Promise<Message[]> {
  const allMessages = await getAllMessages();
  const byId = new Map(allMessages.map((m) => [m.id, m]));

  // Trace back to the root of the thread
  let rootId = messageId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(rootId)) break;
    visited.add(rootId);
    const msg = byId.get(rootId);
    if (!msg || !msg.reply_to) break;
    rootId = msg.reply_to;
  }

  // Collect all messages in the thread (forward from root)
  const thread: Message[] = [];
  const childrenMap = new Map<string, string[]>();

  // Build parent → children mapping
  for (const msg of allMessages) {
    if (msg.reply_to) {
      const children = childrenMap.get(msg.reply_to) ?? [];
      children.push(msg.id);
      childrenMap.set(msg.reply_to, children);
    }
  }

  // Walk the chain from root
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const msg = byId.get(id);
    if (msg) {
      thread.push(msg);
      const children = childrenMap.get(id) ?? [];
      // Sort children by timestamp
      children.sort((a, b) => {
        const ma = byId.get(a);
        const mb = byId.get(b);
        if (!ma || !mb) return 0;
        return new Date(ma.timestamp).getTime() - new Date(mb.timestamp).getTime();
      });
      queue.push(...children);
    }
  }

  // Sort by timestamp
  thread.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return thread;
}

function cleanStaleSessions(sessions: Sessions): Sessions {
  const now = Date.now();
  const cleaned: Sessions = {};
  for (const [name, session] of Object.entries(sessions)) {
    if (now - new Date(session.last_seen).getTime() < SESSION_TTL_MS) {
      cleaned[name] = session;
    }
  }
  return cleaned;
}

// Message TTL: same as session TTL
const MESSAGE_TTL_MS = SESSION_TTL_MS;

async function cleanStaleMessages(): Promise<number> {
  const now = Date.now();
  let cleaned = 0;

  try {
    const dirs = await readdir(MESSAGES_DIR);
    for (const dir of dirs) {
      const dirPath = join(MESSAGES_DIR, dir);
      try {
        const files = await readdir(dirPath);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          try {
            const filePath = join(dirPath, file);
            const data = await readFile(filePath, "utf-8");
            const msg: Message = JSON.parse(data);
            const age = now - new Date(msg.timestamp).getTime();

            // Delete delivered/acknowledged messages older than TTL
            if (age > MESSAGE_TTL_MS && msg.status !== "pending") {
              await unlink(filePath);
              cleaned++;
              continue;
            }

            // For broadcast: delete if fully delivered and older than TTL
            if (dir === "broadcast" && age > MESSAGE_TTL_MS && msg.delivered_to && msg.delivered_to.length > 0) {
              await unlink(filePath);
              cleaned++;
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return cleaned;
}

// ─────────────────────────────────────────────
// tmux notification helper
// ─────────────────────────────────────────────

function execTmux(...args: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("tmux", args, (err) => resolve());
  });
}

async function notifyViaTmux(tmuxTarget: string, message: string): Promise<void> {
  // Send text first
  await execTmux("send-keys", "-t", tmuxTarget, message);
  // Wait then send Enter separately
  await Bun.sleep(500);
  await execTmux("send-keys", "-t", tmuxTarget, "Enter");
}

// ─────────────────────────────────────────────
// In-memory session name for this MCP process
// ─────────────────────────────────────────────

let currentSessionName: string | null = null;

// ─────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────

const server = new McpServer({
  name: "ccwire",
  version: "0.1.0",
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
  await ensureStore();

  return await withFileLock(async () => {
    const sessions = cleanStaleSessions(await readSessions());

    const now = new Date().toISOString();
    sessions[name] = {
      name,
      tmux_target,
      status: "idle",
      registered_at: sessions[name]?.registered_at ?? now,
      last_seen: now,
    };

    await writeSessions(sessions);
    await ensureSessionDir(name);

    currentSessionName = name;

    return {
      content: [
        {
          type: "text" as const,
          text: `セッション "${name}" を登録しました。\n\n現在の接続セッション数: ${Object.keys(sessions).length}`,
        },
      ],
    };
  });
});

// ── wire_send ───────────────────────────────

server.registerTool("wire_send", {
  title: "Wire Send",
  description: "特定のセッションにメッセージを送信する。",
  inputSchema: {
    to: z.string().describe("送信先セッション名"),
    content: z.string().describe("メッセージ内容"),
    type: z.enum(["task_request", "response", "status_update"]).default("task_request").describe("メッセージタイプ"),
    reply_to: z.string().nullable().default(null).describe("返信先メッセージID（返信の場合）"),
  },
}, async ({ to, content, type, reply_to }) => {
  if (!currentSessionName) {
    return {
      content: [{ type: "text" as const, text: "エラー: まず wire_register でセッションを登録してください。" }],
      isError: true,
    };
  }

  await ensureStore();

  return await withFileLock(async () => {
    const sessions = cleanStaleSessions(await readSessions());

    if (!sessions[to]) {
      const available = Object.keys(sessions).join(", ");
      return {
        content: [{ type: "text" as const, text: `エラー: セッション "${to}" が見つかりません。\n利用可能: ${available || "(なし)"}` }],
        isError: true,
      };
    }

    // Update last_seen
    if (sessions[currentSessionName]) {
      sessions[currentSessionName].last_seen = new Date().toISOString();
      await writeSessions(sessions);
    }

    const msg: Message = {
      id: `msg-${randomUUID()}`,
      from: currentSessionName,
      to,
      type: type as Message["type"],
      content,
      timestamp: new Date().toISOString(),
      reply_to: reply_to ?? null,
      status: "pending",
    };

    await writeMessage(msg);

    // Auto-notify via tmux if target has tmux_target
    const targetSession = sessions[to];
    if (targetSession?.tmux_target) {
      await notifyViaTmux(
        targetSession.tmux_target,
        `wire_receiveで未読メッセージを確認して`
      );
    }

    return {
      content: [{
        type: "text" as const,
        text: `メッセージ送信完了\n  ID: ${msg.id}\n  To: ${to}\n  Type: ${type}`,
      }],
    };
  });
});

// ── wire_receive ────────────────────────────

server.registerTool("wire_receive", {
  title: "Wire Receive",
  description: "自分宛の未読メッセージを取得する。",
  inputSchema: {
    limit: z.number().default(10).describe("取得するメッセージの最大数"),
  },
}, async ({ limit }) => {
  if (!currentSessionName) {
    return {
      content: [{ type: "text" as const, text: "エラー: まず wire_register でセッションを登録してください。" }],
      isError: true,
    };
  }

  await ensureStore();

  return await withFileLock(async () => {
    // Update last_seen
    const sessions = await readSessions();
    if (sessions[currentSessionName!]) {
      sessions[currentSessionName!].last_seen = new Date().toISOString();
      await writeSessions(sessions);
    }

    const messages = await readMessages(currentSessionName!, limit);

    // Mark as delivered (with per-session tracking for broadcasts)
    for (const msg of messages) {
      await markMessageDelivered(msg, currentSessionName!);
    }

    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: "未読メッセージはありません。" }],
      };
    }

    const formatted = messages.map((msg, i) => {
      const replyInfo = msg.reply_to ? `  Reply-To: ${msg.reply_to}\n` : "";
      return `[${i + 1}] ${msg.id}\n  From: ${msg.from}\n  Type: ${msg.type}\n  Time: ${msg.timestamp}\n${replyInfo}  Content: ${msg.content}`;
    }).join("\n\n");

    return {
      content: [{
        type: "text" as const,
        text: `未読メッセージ ${messages.length}件:\n\n${formatted}`,
      }],
    };
  });
});

// ── wire_broadcast ──────────────────────────

server.registerTool("wire_broadcast", {
  title: "Wire Broadcast",
  description: "全セッションに一斉メッセージを送信する。",
  inputSchema: {
    content: z.string().describe("ブロードキャストメッセージ内容"),
  },
}, async ({ content }) => {
  if (!currentSessionName) {
    return {
      content: [{ type: "text" as const, text: "エラー: まず wire_register でセッションを登録してください。" }],
      isError: true,
    };
  }

  await ensureStore();

  return await withFileLock(async () => {
    const sessions = cleanStaleSessions(await readSessions());

    // Update last_seen
    if (sessions[currentSessionName!]) {
      sessions[currentSessionName!].last_seen = new Date().toISOString();
      await writeSessions(sessions);
    }

    const msg: Message = {
      id: `msg-${randomUUID()}`,
      from: currentSessionName!,
      to: "*",
      type: "broadcast",
      content,
      timestamp: new Date().toISOString(),
      reply_to: null,
      status: "pending",
    };

    await writeMessage(msg);

    // Auto-notify all sessions with tmux_target
    const recipients = Object.values(sessions).filter(
      (s) => s.name !== currentSessionName && s.tmux_target
    );
    for (const s of recipients) {
      await notifyViaTmux(
        s.tmux_target!,
        `wire_receiveで未読メッセージを確認して`
      );
    }

    const recipientCount = Object.keys(sessions).filter(n => n !== currentSessionName).length;

    return {
      content: [{
        type: "text" as const,
        text: `ブロードキャスト送信完了\n  ID: ${msg.id}\n  対象セッション数: ${recipientCount}`,
      }],
    };
  });
});

// ── wire_sessions ───────────────────────────

server.registerTool("wire_sessions", {
  title: "Wire Sessions",
  description: "接続中のセッション一覧を取得する。",
  inputSchema: {},
}, async () => {
  await ensureStore();

  const sessions = cleanStaleSessions(await readSessions());

  // Opportunistic message cleanup
  const cleanedMsgs = await cleanStaleMessages();

  if (Object.keys(sessions).length === 0) {
    return {
      content: [{ type: "text" as const, text: "登録されたセッションはありません。" }],
    };
  }

  const lines = Object.values(sessions).map((s) => {
    const isSelf = s.name === currentSessionName ? " (自分)" : "";
    const tmux = s.tmux_target ? ` [tmux: ${s.tmux_target}]` : "";
    return `  ${s.name}${isSelf} - ${s.status}${tmux} (last: ${s.last_seen})`;
  });

  const cleanInfo = cleanedMsgs > 0 ? `\n(${cleanedMsgs} 件の古いメッセージを削除)` : "";

  return {
    content: [{
      type: "text" as const,
      text: `接続セッション (${Object.keys(sessions).length}):\n${lines.join("\n")}${cleanInfo}`,
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
  await ensureStore();

  return await withFileLock(async () => {
    const sessions = cleanStaleSessions(await readSessions());

    if (status) {
      if (!currentSessionName || !sessions[currentSessionName]) {
        return {
          content: [{ type: "text" as const, text: "エラー: まず wire_register でセッションを登録してください。" }],
          isError: true,
        };
      }

      sessions[currentSessionName].status = status;
      sessions[currentSessionName].last_seen = new Date().toISOString();
      await writeSessions(sessions);

      return {
        content: [{
          type: "text" as const,
          text: `ステータスを "${status}" に更新しました。`,
        }],
      };
    }

    // Return all statuses
    const lines = Object.values(sessions).map((s) => {
      const isSelf = s.name === currentSessionName ? " ★" : "";
      return `  ${s.name}: ${s.status}${isSelf}`;
    });

    return {
      content: [{
        type: "text" as const,
        text: `全セッションステータス:\n${lines.join("\n")}`,
      }],
    };
  });
});

// ── wire_unregister ──────────────────────────

server.registerTool("wire_unregister", {
  title: "Wire Unregister",
  description: "セッションの登録を解除する。省略時は自分自身を解除する。",
  inputSchema: {
    name: z.string().optional().describe("解除するセッション名。省略時は自分自身。"),
  },
}, async ({ name }) => {
  const targetName = name ?? currentSessionName;

  if (!targetName) {
    return {
      content: [{ type: "text" as const, text: "エラー: セッション名を指定するか、先に wire_register で登録してください。" }],
      isError: true,
    };
  }

  await ensureStore();

  return await withFileLock(async () => {
    const sessions = await readSessions();

    if (!sessions[targetName]) {
      return {
        content: [{ type: "text" as const, text: `エラー: セッション "${targetName}" は登録されていません。` }],
        isError: true,
      };
    }

    delete sessions[targetName];
    await writeSessions(sessions);

    if (targetName === currentSessionName) {
      currentSessionName = null;
    }

    return {
      content: [{
        type: "text" as const,
        text: `セッション "${targetName}" の登録を解除しました。\n残りセッション数: ${Object.keys(sessions).length}`,
      }],
    };
  });
});

// ── wire_ack ────────────────────────────────

server.registerTool("wire_ack", {
  title: "Wire Acknowledge",
  description: "メッセージの受信確認を送る。",
  inputSchema: {
    message_id: z.string().describe("確認するメッセージID"),
  },
}, async ({ message_id }) => {
  if (!currentSessionName) {
    return {
      content: [{ type: "text" as const, text: "エラー: まず wire_register でセッションを登録してください。" }],
      isError: true,
    };
  }

  await ensureStore();

  return await withFileLock(async () => {
    const found = await acknowledgeMessage(message_id, currentSessionName!);

    if (!found) {
      return {
        content: [{ type: "text" as const, text: `エラー: メッセージ "${message_id}" が見つかりません。` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: `メッセージ "${message_id}" を確認済みにしました。`,
      }],
    };
  });
});

// ── wire_thread ────────────────────────────────

server.registerTool("wire_thread", {
  title: "Wire Thread",
  description: "メッセージIDからスレッド（reply_toチェーン）全体を取得する。どのメッセージIDを指定しても、そのスレッドの先頭から末尾まで時系列で返す。",
  inputSchema: {
    message_id: z.string().describe("スレッド内の任意のメッセージID"),
  },
}, async ({ message_id }) => {
  await ensureStore();

  const thread = await buildThread(message_id);

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

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────

async function main() {
  await ensureStore();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ccwire server error:", err);
  process.exit(1);
});
