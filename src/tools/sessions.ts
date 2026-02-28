import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Session } from "../types.js";
import {
  getDb,
  resolveCurrentSession,
  cleanStaleSessions,
  cleanStaleMessages,
  cleanStaleAuditLogs,
} from "../db.js";

export function registerSessionsTools(server: McpServer): void {
  // ── wire_sessions ───────────────────────────

  server.registerTool("wire_sessions", {
    title: "Wire Sessions",
    description: "接続中のセッション一覧を取得する。",
    inputSchema: {},
  }, async () => {
    const db = getDb();

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
    const db = getDb();

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
}
