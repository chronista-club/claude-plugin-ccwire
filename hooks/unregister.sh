#!/bin/bash
# ccwire: SessionEnd auto-unregistration
# CCWIRE_SESSION_NAME 環境変数があれば SQLite DB から削除する

DB_PATH="$HOME/.cache/ccwire/ccwire.db"

# 環境変数がなければ何もしない
if [ -z "$CCWIRE_SESSION_NAME" ]; then
  exit 0
fi

# DB がなければ何もしない
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

SAFE_NAME=$(printf '%s' "$CCWIRE_SESSION_NAME" | sed "s/'/''/g")
sqlite3 "$DB_PATH" "DELETE FROM sessions WHERE name = '$SAFE_NAME';" 2>/dev/null
