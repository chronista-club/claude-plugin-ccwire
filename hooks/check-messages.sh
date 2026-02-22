#!/bin/bash
# ccwire: Check for pending messages (read-only, does not mark as delivered)
# Used by UserPromptSubmit hook to show unread notifications

CCWIRE_DIR="$HOME/.cache/ccwire/messages"
SESSION_NAME="${CCWIRE_SESSION_NAME:-}"

if [ ! -d "$CCWIRE_DIR" ]; then
  echo '{}'
  exit 0
fi

# Early return: check if any JSON files exist at all
shopt -s nullglob
all_json=("$CCWIRE_DIR"/*/*.json)
shopt -u nullglob
if [ ${#all_json[@]} -eq 0 ]; then
  echo '{}'
  exit 0
fi

messages=""
count=0

for dir in "$CCWIRE_DIR"/*/; do
  [ -d "$dir" ] || continue
  for file in "$dir"*.json; do
    [ -f "$file" ] || continue

    # Single jq call to extract all needed fields at once
    read -r status from to content < <(jq -r '[.status // "", .from // "?", .to // "?", (.content // "" | .[0:120])] | @tsv' "$file" 2>/dev/null)

    if [ "$to" = "*" ]; then
      # Broadcast: check per-session delivered_to array
      if [ -n "$SESSION_NAME" ]; then
        # Skip if we sent it
        if [ "$from" = "$SESSION_NAME" ]; then
          continue
        fi
        # Single jq call to check delivered_to for this session
        already_delivered=$(jq -r --arg s "$SESSION_NAME" '.delivered_to // [] | index($s) // empty' "$file" 2>/dev/null)
        if [ -n "$already_delivered" ]; then
          continue
        fi
      else
        # No session name: fall back to status check
        if [ "$status" != "pending" ]; then
          continue
        fi
      fi
      messages="${messages}- [${from} → broadcast]: ${content}\n"
      count=$((count + 1))
    else
      # Direct message: standard status check
      if [ "$status" = "pending" ]; then
        messages="${messages}- [${from} → ${to}]: ${content}\n"
        count=$((count + 1))
      fi
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
