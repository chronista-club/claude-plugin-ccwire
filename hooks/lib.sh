#!/bin/bash
# ccwire: 共通ライブラリ
# register.sh / unregister.sh で共有するユーティリティ関数

DB_PATH="$HOME/.cache/ccwire/ccwire.db"

# SQL/JSON安全なエスケープ
sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# セッション名の決定: 環境変数 > tmux セッション名 > プロジェクトディレクトリ名
resolve_session_name() {
  local name="$CCWIRE_SESSION_NAME"
  if [ -z "$name" ]; then
    name=$(tmux display-message -p '#S' 2>/dev/null)
  fi
  if [ -z "$name" ]; then
    name=$(basename "${CLAUDE_PROJECT_DIR:-$(pwd)}")
  fi
  printf '%s' "$name"
}
