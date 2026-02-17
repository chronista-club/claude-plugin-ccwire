#!/bin/bash
# ccwire: Check for pending messages (read-only, does not mark as delivered)
# Used by UserPromptSubmit hook to show unread notifications

CCWIRE_DIR="$HOME/.cache/ccwire/messages"

if [ ! -d "$CCWIRE_DIR" ]; then
  echo '{}'
  exit 0
fi

messages=""
count=0

for dir in "$CCWIRE_DIR"/*/; do
  [ -d "$dir" ] || continue
  for file in "$dir"*.json; do
    [ -f "$file" ] || continue
    status=$(jq -r '.status // empty' "$file" 2>/dev/null)
    if [ "$status" = "pending" ]; then
      from=$(jq -r '.from // "?"' "$file" 2>/dev/null)
      to=$(jq -r '.to // "?"' "$file" 2>/dev/null)
      content=$(jq -r '.content // ""' "$file" 2>/dev/null | head -c 120)
      if [ "$to" = "*" ]; then
        to="broadcast"
      fi
      messages="${messages}- [${from} → ${to}]: ${content}\n"
      count=$((count + 1))
    fi
  done
done

if [ "$count" -gt 0 ]; then
  # Escape for JSON
  escaped=$(printf '%s' "$messages" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
  echo "{\"additionalContext\": \"## ccwire: 未読メッセージ ${count}件\n${escaped}\"}"
else
  echo '{}'
fi
