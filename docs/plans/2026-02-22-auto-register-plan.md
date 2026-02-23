# セッション自動登録・自動解除 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** CCWIRE_SESSION_NAME 環境変数による自動登録/解除を実装し、セッションの蓄積問題を解消する

**Architecture:** SessionStart/SessionEnd フックのシェルスクリプトが `~/.cache/ccwire/sessions.json` を直接操作。MCP サーバーにも `wire_unregister` ツールを追加。ファイルロックは server.ts と同じ `~/.cache/ccwire/lock` を使用。

**Tech Stack:** Bash (hooks), TypeScript/Bun (MCP server), jq (JSON操作)

---

### Task 1: `wire_unregister` MCP ツール追加

**Files:**
- Modify: `src/server.ts:630` (wire_ack の前に追加)

**Step 1: wire_unregister ツールを server.ts に追加**

`wire_status` ツール定義（630行目）の後、`wire_ack` の前に以下を追加:

```typescript
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
```

**Step 2: 動作確認**

MCP サーバーを起動して `wire_register` → `wire_unregister` の流れをテスト:

```bash
bun run src/server.ts
# (MCP経由で wire_register → wire_sessions → wire_unregister → wire_sessions で確認)
```

**Step 3: コミット**

```bash
git add src/server.ts
git commit -m "feat: wire_unregister ツール追加"
```

---

### Task 2: SessionStart フック（register.sh）

**Files:**
- Create: `hooks/register.sh`
- Modify: `hooks/hooks.json`

**Step 1: hooks/register.sh を作成**

```bash
#!/bin/bash
# ccwire: SessionStart auto-registration
# CCWIRE_SESSION_NAME 環境変数があれば sessions.json に直接登録する

CCWIRE_DIR="$HOME/.cache/ccwire"
SESSIONS_FILE="$CCWIRE_DIR/sessions.json"
LOCK_FILE="$CCWIRE_DIR/lock"

# 環境変数がなければ従来のガイドメッセージを表示
if [ -z "$CCWIRE_SESSION_NAME" ]; then
  cat <<'GUIDE'
{"additionalContext": "## ccwire-protocol\n\nCC間通信プロトコルが利用可能です。\n\n他のCCセッションと通信するには、まず `wire_register` でセッションを登録してください。\n\n```\nwire_register(name=\"your-session-name\")\n```\n\n登録後は wire_send / wire_receive でメッセージの送受信、wire_sessions でセッション一覧確認ができます。"}
GUIDE
  exit 0
fi

# ストアディレクトリ確保
mkdir -p "$CCWIRE_DIR/messages/$CCWIRE_SESSION_NAME"

# ファイルロック取得（mkdir ベース、最大5秒）
acquire_lock() {
  local max_retries=50
  local i=0
  while [ $i -lt $max_retries ]; do
    if mkdir "$LOCK_FILE" 2>/dev/null; then
      return 0
    fi
    # stale lock check (10秒超)
    if [ -d "$LOCK_FILE" ]; then
      local lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
      if [ "$lock_age" -gt 10 ]; then
        rmdir "$LOCK_FILE" 2>/dev/null
        continue
      fi
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

release_lock() {
  rmdir "$LOCK_FILE" 2>/dev/null
}

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# sessions.json 読み込み（なければ空オブジェクト）
if [ -f "$SESSIONS_FILE" ]; then
  SESSIONS=$(cat "$SESSIONS_FILE")
else
  SESSIONS="{}"
fi

# tmux_target の組み立て
TMUX_TARGET_JSON="null"
if [ -n "$CCWIRE_TMUX_TARGET" ]; then
  TMUX_TARGET_JSON="\"$CCWIRE_TMUX_TARGET\""
fi

# 既存の registered_at を保持、なければ現在時刻
EXISTING_REGISTERED=$(echo "$SESSIONS" | jq -r --arg name "$CCWIRE_SESSION_NAME" '.[$name].registered_at // empty' 2>/dev/null)
if [ -n "$EXISTING_REGISTERED" ]; then
  REGISTERED_AT="$EXISTING_REGISTERED"
else
  REGISTERED_AT="$NOW"
fi

# セッションエントリを追加
NEW_SESSION=$(jq -n \
  --arg name "$CCWIRE_SESSION_NAME" \
  --arg status "idle" \
  --arg registered_at "$REGISTERED_AT" \
  --arg last_seen "$NOW" \
  --argjson tmux_target "$TMUX_TARGET_JSON" \
  '{
    name: $name,
    status: $status,
    registered_at: $registered_at,
    last_seen: $last_seen
  } + (if $tmux_target != null then {tmux_target: $tmux_target} else {} end)'
)

UPDATED=$(echo "$SESSIONS" | jq --arg name "$CCWIRE_SESSION_NAME" --argjson session "$NEW_SESSION" '.[$name] = $session')

# ロック取得して書き込み
if acquire_lock; then
  echo "$UPDATED" > "$SESSIONS_FILE"
  release_lock
fi

# 登録完了メッセージ
SESSION_COUNT=$(echo "$UPDATED" | jq 'length')
cat <<EOF
{"additionalContext": "## ccwire: 自動登録完了\n\nセッション \"${CCWIRE_SESSION_NAME}\" を自動登録しました。（計 ${SESSION_COUNT} セッション）\n\nwire_send / wire_receive でメッセージの送受信が可能です。\n\n**重要**: このセッションは wire_register 済みです。再度の wire_register は不要です。currentSessionName を同期するため、会話の最初に一度だけ wire_register(name=\"${CCWIRE_SESSION_NAME}\") を実行してください。"}
EOF
```

**Step 2: 実行権限を付与**

```bash
chmod +x hooks/register.sh
```

**Step 3: hooks.json の SessionStart を更新**

hooks.json の SessionStart エントリを `register.sh` に差し替え:

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/register.sh"
      }
    ]
  }
]
```

**Step 4: 手動テスト**

```bash
# 環境変数なしで実行 → ガイドメッセージが出る
./hooks/register.sh

# 環境変数ありで実行 → sessions.json に登録される
CCWIRE_SESSION_NAME=test-session CCWIRE_TMUX_TARGET=cw:0.0 ./hooks/register.sh
cat ~/.cache/ccwire/sessions.json | jq .
```

**Step 5: コミット**

```bash
git add hooks/register.sh hooks/hooks.json
git commit -m "feat: SessionStart フックで CCWIRE_SESSION_NAME 自動登録"
```

---

### Task 3: SessionEnd フック（unregister.sh）

**Files:**
- Create: `hooks/unregister.sh`
- Modify: `hooks/hooks.json`

**Step 1: hooks/unregister.sh を作成**

```bash
#!/bin/bash
# ccwire: SessionEnd auto-unregistration
# CCWIRE_SESSION_NAME 環境変数があれば sessions.json から削除する

CCWIRE_DIR="$HOME/.cache/ccwire"
SESSIONS_FILE="$CCWIRE_DIR/sessions.json"
LOCK_FILE="$CCWIRE_DIR/lock"

# 環境変数がなければ何もしない
if [ -z "$CCWIRE_SESSION_NAME" ]; then
  exit 0
fi

# sessions.json がなければ何もしない
if [ ! -f "$SESSIONS_FILE" ]; then
  exit 0
fi

# ファイルロック（register.sh と同じ）
acquire_lock() {
  local max_retries=50
  local i=0
  while [ $i -lt $max_retries ]; do
    if mkdir "$LOCK_FILE" 2>/dev/null; then
      return 0
    fi
    if [ -d "$LOCK_FILE" ]; then
      local lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
      if [ "$lock_age" -gt 10 ]; then
        rmdir "$LOCK_FILE" 2>/dev/null
        continue
      fi
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

release_lock() {
  rmdir "$LOCK_FILE" 2>/dev/null
}

# セッションを削除
SESSIONS=$(cat "$SESSIONS_FILE")
UPDATED=$(echo "$SESSIONS" | jq --arg name "$CCWIRE_SESSION_NAME" 'del(.[$name])')

if acquire_lock; then
  echo "$UPDATED" > "$SESSIONS_FILE"
  release_lock
fi
```

**Step 2: 実行権限を付与**

```bash
chmod +x hooks/unregister.sh
```

**Step 3: hooks.json に SessionEnd を追加**

```json
"SessionEnd": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/unregister.sh"
      }
    ]
  }
]
```

**Step 4: 手動テスト**

```bash
# register してから unregister
CCWIRE_SESSION_NAME=test-session ./hooks/register.sh
cat ~/.cache/ccwire/sessions.json | jq .

CCWIRE_SESSION_NAME=test-session ./hooks/unregister.sh
cat ~/.cache/ccwire/sessions.json | jq .
# → test-session が消えている
```

**Step 5: コミット**

```bash
git add hooks/unregister.sh hooks/hooks.json
git commit -m "feat: SessionEnd フックで自動 unregister"
```

---

### Task 4: ファイルロックの整合性修正

**Files:**
- Modify: `src/server.ts:61-93`

**Step 1: server.ts のファイルロックを mkdir ベースに統一**

現在 server.ts は `writeFile(..., {flag: "wx"})` でファイルベースのロックを使っているが、
シェルスクリプト側は `mkdir` ベースのロックを使う。両者が同じロックを共有するために、
server.ts も `mkdir` ベースに変更する:

```typescript
async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = LOCK_FILE;
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // mkdir は atomic — 同名ディレクトリが存在すると EEXIST
      await mkdir(lockDir, { recursive: false });
      try {
        return await fn();
      } finally {
        await unlink(lockDir).catch(() => {});
        // rmdir for directory-based lock
        const { rmdir } = await import("node:fs/promises");
        await rmdir(lockDir).catch(() => {});
      }
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check if lock is stale (> 10 seconds)
        try {
          const lockStat = await stat(lockDir);
          if (Date.now() - lockStat.mtimeMs > 10_000) {
            const { rmdir } = await import("node:fs/promises");
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
```

**Step 2: テスト — MCP サーバーが正常動作すること確認**

```bash
bun run src/server.ts
# wire_register → wire_send → wire_receive で一連の動作確認
```

**Step 3: コミット**

```bash
git add src/server.ts
git commit -m "fix: ファイルロックを mkdir ベースに統一（シェルスクリプトと互換）"
```

---

### Task 5: スキルドキュメント更新

**Files:**
- Modify: `skills/ccwire-protocol/SKILL.md`

**Step 1: SKILL.md に環境変数と自動登録の説明を追記**

既存の「使い方」セクションの前に以下を追加:

```markdown
## 自動登録（環境変数）

プロセス管理側が以下の環境変数をセットすると、SessionStart 時に自動登録される:

| 環境変数 | 必須 | 説明 |
|----------|------|------|
| `CCWIRE_SESSION_NAME` | Yes | セッション名 |
| `CCWIRE_TMUX_TARGET` | No | tmux ターゲット |

自動登録時は `wire_register` の手動呼び出しは不要。SessionEnd 時に自動で unregister される。

環境変数が未設定の場合は従来通り手動 `wire_register` が必要。
```

また `wire_unregister` ツールの説明を追加:

```markdown
### wire_unregister — セッション登録解除

```
wire_unregister(name="issue-2")  # 指定セッションを解除
wire_unregister()                # 自分自身を解除
```
```

**Step 2: コミット**

```bash
git add skills/ccwire-protocol/SKILL.md
git commit -m "docs: 自動登録と wire_unregister のドキュメント追加"
```
