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
      # Cross-platform: macOS uses stat -f %m, Linux uses stat -c %Y
      local mtime
      if stat -f %m "$LOCK_FILE" &>/dev/null; then
        mtime=$(stat -f %m "$LOCK_FILE")
      elif stat -c %Y "$LOCK_FILE" &>/dev/null; then
        mtime=$(stat -c %Y "$LOCK_FILE")
      else
        mtime=0
      fi
      local lock_age=$(( $(date +%s) - mtime ))
      if [ "$lock_age" -gt 10 ]; then
        rmdir "$LOCK_FILE" 2>/dev/null
        continue
      fi
    fi
    sleep 0.05
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
