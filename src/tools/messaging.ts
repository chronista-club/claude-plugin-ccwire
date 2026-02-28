import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Session, MessageRow } from "../types.js";
import {
  getDb,
  resolveCurrentSession,
  auditLog,
  touchSession,
  cleanStaleSessions,
} from "../db.js";
import { notifyViaTmux } from "../tmux.js";

export function registerMessagingTools(server: McpServer): void {
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
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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

  // ── wire_ack ────────────────────────────────

  server.registerTool("wire_ack", {
    title: "Wire Acknowledge",
    description: "メッセージの受信確認を送る。",
    inputSchema: {
      message_id: z.string().describe("確認するメッセージID"),
    },
  }, async ({ message_id }) => {
    const db = getDb();
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
}
