#!/bin/bash
# ccwire: SessionEnd auto-unregistration
# セッション名を自動解決し、SQLite DB から削除する

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

CCWIRE_SESSION_NAME=$(resolve_session_name)

# セッション名が解決できなければ何もしない
if [ -z "$CCWIRE_SESSION_NAME" ]; then
  exit 0
fi

# DB がなければ何もしない
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

SAFE_NAME=$(sql_escape "$CCWIRE_SESSION_NAME")
run_sql "DELETE FROM sessions WHERE name = '${SAFE_NAME}';"
