import { execFile } from "node:child_process";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const TMUX_CACHE_TTL_MS = 30_000;
const TMUX_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────
// tmux ライブネスチェック キャッシュ (Issue #8)
// ─────────────────────────────────────────────

const tmuxLivenessCache = new Map<string, { alive: boolean; checkedAt: number }>();

export function isTmuxPaneAlive(tmuxTarget: string, useCache = true): boolean {
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

export function clearTmuxCache(tmuxTarget: string): void {
  tmuxLivenessCache.delete(tmuxTarget);
}

// ─────────────────────────────────────────────
// tmux command helpers
// ─────────────────────────────────────────────

export function execTmux(...args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS }, (err) => {
      if (err) {
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

export async function notifyViaTmux(tmuxTarget: string, message: string): Promise<void> {
  await execTmux("send-keys", "-t", tmuxTarget, "-l", message);
  await Bun.sleep(500);
  await execTmux("send-keys", "-t", tmuxTarget, "Enter");
}
