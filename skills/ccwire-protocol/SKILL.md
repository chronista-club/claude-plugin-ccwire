---
name: ccwire-protocol
description: CC間通信プロトコル。複数のClaude Codeセッション間でリアルタイムにメッセージをやり取りする。wire_register, wire_send, wire_receive等のMCPツールでセッション登録・メッセージ送受信を行う。
---

# ccwire-protocol

CC間通信プロトコル。複数のClaude Codeセッションが同一マシン上で並行稼働する環境で、セッション同士がメッセージを交換する仕組み。

## 使い方

### 1. セッション登録（必須・最初に行う）

```
wire_register(name="nexus-main")
```

- セッション名は自由に付けられる（例: "nexus-main", "issue-2", "worker-a"）
- 登録しないとメッセージの送受信ができない
- 同じ名前で再登録するとlast_seenが更新される

### 2. メッセージ送信

```
wire_send(to="issue-2", content="認証モジュールのリファクタリングをお願い", type="task_request")
```

**メッセージタイプ**:

| type | 用途 |
|------|------|
| `task_request` | タスク依頼（デフォルト） |
| `response` | 返答・報告 |
| `status_update` | ステータス変更通知 |

### 3. メッセージ受信

```
wire_receive(limit=10)
```

- 自分宛の未読メッセージ + ブロードキャストを取得
- 取得したメッセージは「delivered」に変わる

### 4. 受信確認

```
wire_ack(message_id="msg-xxxx-xxxx")
```

### 5. ブロードキャスト

```
wire_broadcast(content="全セッション: mainブランチを更新しました。pullしてください。")
```

### 6. セッション一覧

```
wire_sessions()
```

### 7. ステータス管理

```
wire_status(status="busy")   # 自分のステータスを変更
wire_status()                 # 全体のステータス表示
```

ステータス値: `idle`（待機中）, `busy`（作業中）, `done`（完了）

## MCP ツール一覧

| ツール | パラメータ | 説明 |
|--------|-----------|------|
| `wire_register` | `name`, `tmux_target?` | セッション登録 |
| `wire_send` | `to`, `content`, `type?`, `reply_to?` | メッセージ送信 |
| `wire_receive` | `limit?` | 未読メッセージ取得 |
| `wire_broadcast` | `content` | 全体ブロードキャスト |
| `wire_sessions` | - | セッション一覧 |
| `wire_status` | `status?` | ステータス更新/取得 |
| `wire_ack` | `message_id` | 受信確認 |

## メッセージフォーマット

```json
{
  "id": "msg-<uuid>",
  "from": "nexus-main",
  "to": "issue-2",
  "type": "task_request",
  "content": "メッセージ内容",
  "timestamp": "2026-02-17T09:00:00Z",
  "reply_to": null,
  "status": "pending"
}
```

## ワークフロー例

### タスク依頼と報告

```
Session A (nexus-main):
  wire_send(to="issue-2", content="REQ-AUTH-001の実装をお願い", type="task_request")

Session B (issue-2):
  wire_receive() → タスクを受信
  wire_ack(message_id="msg-xxx")
  # ... 作業 ...
  wire_send(to="nexus-main", content="REQ-AUTH-001完了しました", type="response", reply_to="msg-xxx")
```

### 全体通知

```
Session A:
  wire_broadcast(content="mainブランチを v2.0.0 にタグ付けしました")

Session B, C, D:
  wire_receive() → ブロードキャストを受信
```

## アーキテクチャ

```
CC Session A ◄──► MCP tools ◄──► ccwire MCP Server ◄──► ~/.cache/ccwire/ (共有ストア)
CC Session B ◄──► MCP tools ◄──► ccwire MCP Server ◄──►        ↑
CC Session C ◄──► MCP tools ◄──► ccwire MCP Server ◄──────────┘
```

各CCセッションが独自のMCPサーバープロセスを起動し、ファイルベースの共有ストア (`~/.cache/ccwire/`) を通じてメッセージを交換する。

## 注意事項

- セッションは24時間で自動的に期限切れになる
- ファイルロックで同時書き込みを防止
- ブロードキャストは送信元には配信されない
