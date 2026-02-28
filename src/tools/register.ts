import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import type { Session } from "../types.js";
import {
  getDb,
  getCurrentSessionName,
  setCurrentSessionName,
  resolveCurrentSession,
  auditLog,
  cleanStaleSessions,
} from "../db.js";

export function registerRegisterTools(server: McpServer): void {
  // ── wire_register ───────────────────────────

  server.registerTool("wire_register", {
    title: "Wire Register",
    description: "セッションを登録する。名前は自由に付けられる（例: 'nexus-main', 'issue-2'）。登録するとメッセージの送受信が可能になる。",
    inputSchema: {
      name: z.string().describe("セッション名（例: 'nexus-main', 'issue-2'）"),
      tmux_target: z.string().optional().describe("tmuxターゲット（例: 'session:window.pane'）。省略可。"),
    },
  }, async ({ name, tmux_target }) => {
    const db = getDb();

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
      `INSERT OR REPLACE INTO sessions (name, tmux_target, pid, broadcast_cursor, status, registered_at, last_seen)
       VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
      [name, validatedTmuxTarget, process.pid, now, existing?.registered_at ?? now, now]
    );

    setCurrentSessionName(name);

    auditLog("register", name, { tmux_target: validatedTmuxTarget });

    const count = db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM sessions`).get()!.cnt;

    const message = tmuxWarning
      ? `セッション "${name}" を登録しました。\n\n${tmuxWarning}\n\n現在の接続セッション数: ${count}`
      : `セッション "${name}" を登録しました。\n\n現在の接続セッション数: ${count}`;

    return {
      content: [{ type: "text" as const, text: message }],
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
    const db = getDb();
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

    if (targetName === getCurrentSessionName()) {
      setCurrentSessionName(null);
    }

    const remaining = db.query<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM sessions`).get()!.cnt;

    return {
      content: [{
        type: "text" as const,
        text: `セッション "${targetName}" の登録を解除しました。\n残りセッション数: ${remaining}`,
      }],
    };
  });
}
