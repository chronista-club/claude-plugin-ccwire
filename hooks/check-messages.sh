#!/bin/bash
# ccwire: Check for pending messages (read-only, does not mark as delivered)
# Used by UserPromptSubmit hook to show unread notifications

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

SESSION_NAME=$(resolve_session_name)

if [ ! -f "$DB_PATH" ]; then
  echo '{}'
  exit 0
fi

SAFE_SESSION=$(sql_escape "$SESSION_NAME")

# Direct messages (pending, addressed to me or no session name)
if [ -n "$SESSION_NAME" ]; then
  DIRECT=$(run_sql -separator '|' "
    SELECT \"from\", \"to\", substr(content, 1, 120)
    FROM messages
    WHERE \"to\" = '${SAFE_SESSION}' AND status = 'pending'
    ORDER BY timestamp ASC;
  ")

  # Broadcast messages (not from me, not yet delivered to me)
  BROADCAST=$(run_sql -separator '|' "
    SELECT m.\"from\", 'broadcast', substr(m.content, 1, 120)
    FROM messages m
    WHERE m.\"to\" = '*'
      AND m.\"from\" != '${SAFE_SESSION}'
      AND m.id NOT IN (SELECT message_id FROM broadcast_deliveries WHERE session_name = '${SAFE_SESSION}')
    ORDER BY m.timestamp ASC;
  ")
else
  # No session name: show all pending messages
  DIRECT=$(run_sql -separator '|' "
    SELECT \"from\", \"to\", substr(content, 1, 120)
    FROM messages
    WHERE status = 'pending' AND \"to\" != '*'
    ORDER BY timestamp ASC;
  ")

  BROADCAST=$(run_sql -separator '|' "
    SELECT \"from\", 'broadcast', substr(content, 1, 120)
    FROM messages
    WHERE \"to\" = '*' AND status = 'pending'
    ORDER BY timestamp ASC;
  ")
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
  safe_from=$(json_escape "$from")
  safe_to=$(json_escape "$to")
  safe_content=$(json_escape "$content")
  messages="${messages}- [${safe_from} → ${safe_to}]: ${safe_content}\\n"
  count=$((count + 1))
done <<< "$ALL_MESSAGES"

if [ "$count" -gt 0 ]; then
  echo "{\"additionalContext\": \"## ccwire: 未読メッセージ ${count}件\\n${messages}\"}"
else
  echo '{}'
fi
