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
