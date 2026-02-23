#!/bin/bash
# ccwire: 共通ライブラリ
# register.sh / unregister.sh / check-messages.sh で共有するユーティリティ関数

DB_PATH="$HOME/.cache/ccwire/ccwire.db"
LOG_DIR="$HOME/.cache/ccwire"
LOG="$LOG_DIR/hooks.log"

# ログディレクトリの確保
mkdir -p "$LOG_DIR" 2>/dev/null

# SQL安全なエスケープ（シングルクォート二重化）
sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

# JSON安全なエスケープ（バックスラッシュ、ダブルクォート、制御文字対応）
json_escape() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e 's/\t/\\t/g' | tr '\n' ' ' | tr '\r' ' '
}

# セッション名の決定: 環境変数 > tmux セッション名 > プロジェクトディレクトリ名
resolve_session_name() {
  local name="$CCWIRE_SESSION_NAME"
  if [ -z "$name" ]; then
    name=$(tmux display-message -p '#S' 2>>"$LOG")
  fi
  if [ -z "$name" ]; then
    name=$(basename "${CLAUDE_PROJECT_DIR:-$(pwd)}")
  fi
  printf '%s' "$name"
}

# sqlite3 ラッパー: エラーをログに記録
run_sql() {
  sqlite3 "$DB_PATH" "$@" 2>>"$LOG"
}
