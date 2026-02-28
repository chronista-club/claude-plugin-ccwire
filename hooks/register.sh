#!/bin/bash
# ccwire: SessionStart auto-registration
# セッション名を自動解決し、SQLite DB に直接登録する

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

CCWIRE_SESSION_NAME=$(resolve_session_name)

# tmux_target の自動検出
if [ -z "$CCWIRE_TMUX_TARGET" ]; then
  CCWIRE_TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>>"$LOG")
fi

SAFE_NAME=$(sql_escape "$CCWIRE_SESSION_NAME")
JSON_NAME=$(json_escape "$CCWIRE_SESSION_NAME")

# DB がなければ MCP サーバーがまだ起動していない → ガイドメッセージだけ出す
if [ ! -f "$DB_PATH" ]; then
  cat <<EOF
{"additionalContext": "## ccwire: DB未初期化\n\nccwire DBがまだ作成されていません。\nwire_register(name=\"${JSON_NAME}\") を実行してセッションを登録してください。"}
EOF
  exit 0
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# tmux_target の組み立て
TMUX_TARGET="null"
if [ -n "$CCWIRE_TMUX_TARGET" ]; then
  SAFE_TMUX=$(sql_escape "$CCWIRE_TMUX_TARGET")
  TMUX_TARGET="'$SAFE_TMUX'"
fi

# 既存の registered_at を保持、なければ現在時刻
EXISTING_REGISTERED=$(run_sql "SELECT registered_at FROM sessions WHERE name = '${SAFE_NAME}';")
if [ -n "$EXISTING_REGISTERED" ]; then
  REGISTERED_AT=$(sql_escape "$EXISTING_REGISTERED")
else
  REGISTERED_AT="$NOW"
fi

# INSERT OR REPLACE でセッション登録（broadcast_cursor, pid も設定）
run_sql "INSERT OR REPLACE INTO sessions (name, tmux_target, pid, broadcast_cursor, status, registered_at, last_seen) VALUES ('${SAFE_NAME}', ${TMUX_TARGET}, $$, '${NOW}', 'idle', '${REGISTERED_AT}', '${NOW}');"

# 登録完了メッセージ
SESSION_COUNT=$(run_sql "SELECT COUNT(*) FROM sessions;")
cat <<EOF
{"additionalContext": "## ccwire: 自動登録完了\n\nセッション \"${JSON_NAME}\" を自動登録しました。（計 ${SESSION_COUNT} セッション）\n\nwire_send / wire_receive でメッセージの送受信が可能です。\n\n**重要**: このセッションは wire_register 済みです。再度の wire_register は不要です。currentSessionName を同期するため、会話の最初に一度だけ wire_register(name=\"${JSON_NAME}\") を実行してください。"}
EOF
