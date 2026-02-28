export interface Session {
  name: string;
  tmux_target: string | null;
  pid: number | null;
  status: "idle" | "busy" | "done";
  registered_at: string;
  last_seen: string;
}

export interface MessageRow {
  id: string;
  from: string;
  to: string;
  type: string;
  content: string;
  timestamp: string;
  reply_to: string | null;
  status: string;
}
