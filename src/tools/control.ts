import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Session, MessageRow } from "../types.js";
import {
  getDb,
  resolveCurrentSession,
  auditLog,
  cleanStaleSessions,
} from "../db.js";
import { execTmux } from "../tmux.js";

export function registerControlTools(server: McpServer): void {
  // ── wire_thread ────────────────────────────────

  server.registerTool("wire_thread", {
    title: "Wire Thread",
    description: "メッセージIDからスレッド（reply_toチェーン）全体を取得する。どのメッセージIDを指定しても、そのスレッドの先頭から末尾まで時系列で返す。",
    inputSchema: {
      message_id: z.string().describe("スレッド内の任意のメッセージID"),
    },
  }, async ({ message_id }) => {
    const db = getDb();
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
      SELECT DISTINCT msg.* FROM messages msg
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
    const db = getDb();
    const self = resolveCurrentSession();
    if (!self) {
      return {
        content: [{ type: "text" as const, text: "エラー: セッションが見つかりません。wire_register で登録してください。" }],
        isError: true,
      };
    }

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

    auditLog("control", self, {
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
}
