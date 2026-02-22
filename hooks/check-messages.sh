#!/bin/bash
# ccwire: Check for pending messages (read-only, does not mark as delivered)
# Used by UserPromptSubmit hook to show unread notifications

DB_PATH="$HOME/.cache/ccwire/ccwire.db"
SESSION_NAME="${CCWIRE_SESSION_NAME:-}"

if [ ! -f "$DB_PATH" ]; then
  echo '{}'
  exit 0
fi

# Direct messages (pending, addressed to me or no session name)
if [ -n "$SESSION_NAME" ]; then
  DIRECT=$(sqlite3 -separator '|' "$DB_PATH" "
    SELECT \"from\", \"to\", substr(content, 1, 120)
    FROM messages
    WHERE \"to\" = '$SESSION_NAME' AND status = 'pending'
    ORDER BY timestamp ASC;
  " 2>/dev/null)

  # Broadcast messages (not from me, not yet delivered to me)
  BROADCAST=$(sqlite3 -separator '|' "$DB_PATH" "
    SELECT m.\"from\", 'broadcast', substr(m.content, 1, 120)
    FROM messages m
    WHERE m.\"to\" = '*'
      AND m.\"from\" != '$SESSION_NAME'
      AND m.id NOT IN (SELECT message_id FROM broadcast_deliveries WHERE session_name = '$SESSION_NAME')
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
  messages="${messages}- [${from} → ${to}]: ${content}\\n"
  count=$((count + 1))
done <<< "$ALL_MESSAGES"

if [ "$count" -gt 0 ]; then
  # Escape for JSON
  escaped=$(printf '%s' "$messages" | sed 's/"/\\"/g; s/\t/\\t/g')
  echo "{\"additionalContext\": \"## ccwire: 未読メッセージ ${count}件\\n${escaped}\"}"
else
  echo '{}'
fi
