#!/bin/bash
# ccwire: Check for pending messages (read-only, does not mark as delivered)
# Used by UserPromptSubmit hook to show unread notifications

DB_PATH="$HOME/.cache/ccwire/ccwire.db"
SESSION_NAME="${CCWIRE_SESSION_NAME:-}"

if [ ! -f "$DB_PATH" ]; then
  echo '{}'
  exit 0
fi

# SQL安全なエスケープ
sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

SAFE_SESSION=$(sql_escape "$SESSION_NAME")

# Direct messages (pending, addressed to me or no session name)
if [ -n "$SESSION_NAME" ]; then
  DIRECT=$(sqlite3 -separator '|' "$DB_PATH" "
    SELECT \"from\", \"to\", substr(content, 1, 120)
    FROM messages
    WHERE \"to\" = '$SAFE_SESSION' AND status = 'pending'
    ORDER BY timestamp ASC;
  " 2>/dev/null)

  # Broadcast messages (not from me, not yet delivered to me)
  BROADCAST=$(sqlite3 -separator '|' "$DB_PATH" "
    SELECT m.\"from\", 'broadcast', substr(m.content, 1, 120)
    FROM messages m
    WHERE m.\"to\" = '*'
      AND m.\"from\" != '$SAFE_SESSION'
      AND m.id NOT IN (SELECT message_id FROM broadcast_deliveries WHERE session_name = '$SAFE_SESSION')
    ORDER BY m.timestamp ASC;
  " 2>/dev/null)
else
  # No session name: show all pending messages
  DIRECT=$(sqlite3 -separator '|' "$DB_PATH" "
    SELECT \"from\", \"to\", substr(content, 1, 120)
    FROM messages
    WHERE status = 'pending' AND \"to\" != '*'
    ORDER BY timestamp ASC;
  " 2>/dev/null)

  BROADCAST=$(sqlite3 -separator '|' "$DB_PATH" "
    SELECT \"from\", 'broadcast', substr(content, 1, 120)
    FROM messages
    WHERE \"to\" = '*' AND status = 'pending'
    ORDER BY timestamp ASC;
  " 2>/dev/null)
fi

# Combine results
ALL_MESSAGES="${DIRECT}
${BROADCAST}"
ALL_MESSAGES=$(echo "$ALL_MESSAGES" | sed '/^$/d')

if [ -z "$ALL_MESSAGES" ]; then
  echo '{}'
  exit 0
fi

count=0
messages=""

while IFS='|' read -r from to content; do
  [ -z "$from" ] && continue
  # JSON安全なエスケープ（バックスラッシュ → ダブルクォート → 改行 → タブ）
  safe_from=$(printf '%s' "$from" | sed 's/\\/\\\\/g; s/"/\\"/g')
  safe_to=$(printf '%s' "$to" | sed 's/\\/\\\\/g; s/"/\\"/g')
  safe_content=$(printf '%s' "$content" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r' '  ')
  messages="${messages}- [${safe_from} → ${safe_to}]: ${safe_content}\\n"
  count=$((count + 1))
done <<< "$ALL_MESSAGES"

if [ "$count" -gt 0 ]; then
  echo "{\"additionalContext\": \"## ccwire: 未読メッセージ ${count}件\\n${messages}\"}"
else
  echo '{}'
fi
