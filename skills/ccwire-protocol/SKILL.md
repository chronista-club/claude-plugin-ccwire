---
name: ccwire-protocol
description: CC間通信プロトコル。複数のClaude Codeセッション間でリアルタイムにメッセージをやり取りする。wire_register, wire_send, wire_receive等のMCPツールでセッション登録・メッセージ送受信を行う。
---

# ccwire-protocol

CC間通信プロトコル。複数のClaude Codeセッションが同一マシン上で並行稼働する環境で、セッション同士がメッセージを交換する仕組み。

## 自動登録（環境変数）

プロセス管理側が以下の環境変数をセットすると、SessionStart 時に自動登録される:

| 環境変数 | 必須 | 説明 |
|----------|------|------|
| `CCWIRE_SESSION_NAME` | Yes | セッション名 |
| `CCWIRE_TMUX_TARGET` | No | tmux ターゲット |

自動登録時は `wire_register` の手動呼び出しは不要（ただし MCP の currentSessionName 同期のため、会話の最初に一度だけ `wire_register(name="セッション名")` を実行する）。
SessionEnd 時に自動で unregister される。

環境変数が未設定の場合は従来通り手動 `wire_register` が必要。

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
| `question` | 質問・確認 |
| `health_ping` | ヘルスチェック |
| `conflict_warning` | コンフリクト警告 |

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

### 8. セッション登録解除

```
wire_unregister(name="issue-2")  # 指定セッションを解除
wire_unregister()                # 自分自身を解除
```

- 省略時は自分自身を解除
- SessionEnd フックで自動実行されるため、通常は手動呼び出し不要

### 9. スレッド取得

```
wire_thread(message_id="msg-xxxx-xxxx")
```

- スレッド内の**どのメッセージID**を指定しても、先頭から末尾まで時系列で返す
- `reply_to`チェーンを自動的に辿ってLinked Listとして再構成
- 過去の会話コンテキストを復元するのに便利

### 10. セッション制御（tmux）

```
wire_control(session="issue-2", action="accept")
wire_control(session="issue-2", action="text", text="y")
```

- `enter`: Enter キー送信
- `accept`: y + Enter（Permission prompt の承認）
- `reject`: n + Enter（拒否）
- `interrupt`: Ctrl+C（中断）
- `text`: テキスト入力 + Enter

対象セッションに `tmux_target` が設定されている必要がある。

## MCP ツール一覧

| ツール | パラメータ | 説明 |
|--------|-----------|------|
| `wire_register` | `name`, `tmux_target?` | セッション登録 |
| `wire_unregister` | `name?` | セッション登録解除（省略時は自分自身） |
| `wire_send` | `to`, `content`, `type?`, `reply_to?` | メッセージ送信 |
| `wire_receive` | `limit?` | 未読メッセージ取得 |
| `wire_broadcast` | `content` | 全体ブロードキャスト |
| `wire_sessions` | - | セッション一覧 |
| `wire_status` | `status?` | ステータス更新/取得 |
| `wire_ack` | `message_id` | 受信確認 |
| `wire_thread` | `message_id` | スレッド全体を取得（reply_toチェーンを辿る） |
| `wire_control` | `session`, `action`, `text?` | tmuxペインにキーストローク送信 |

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
CC Session A ◄──► MCP tools ◄──► ccwire MCP Server ◄──► ~/.cache/ccwire/ccwire.db (SQLite WAL)
CC Session B ◄──► MCP tools ◄──► ccwire MCP Server ◄──►        ↑
CC Session C ◄──► MCP tools ◄──► ccwire MCP Server ◄──────────┘
```

各CCセッションが独自のMCPサーバープロセスを起動し、SQLite DB (`~/.cache/ccwire/ccwire.db`) を通じてメッセージを交換する。WAL モードにより複数プロセスからの同時アクセスに対応。

## tmux send-keys でCCにメッセージを送る場合

ccwire MCPツールが使えない状況（相手がまだ未登録、プラグイン未導入等）では、`tmux send-keys` でCCの入力欄に直接テキストを送ることができる。

**必須ルール: send-keys とEnter は必ず2回に分けて送る**

```bash
# 正しい例: メッセージとEnterを別々のコマンドで送る
tmux send-keys -t cw:0.0 "メッセージ内容"
tmux send-keys -t cw:0.0 Enter
```

```bash
# 間違い: 1つのコマンドでメッセージとEnterを同時に送る
# → 入力が確定せずメッセージが届かない場合がある
tmux send-keys -t cw:0.0 "メッセージ内容" Enter
```

Enterがないとメッセージは入力欄に表示されるだけで、CCには送信されない。**Enterでメッセージが到達する。** また、メッセージとEnterを同一コマンドで送ると入力が確定しないケースがあるため、**必ず別コマンドに分けること。**

**必須ルール: Enter送信の5秒後に到達確認する**

Enter を送った後、相手のセッションが実際に反応して進行しているか確認する。メッセージがスタックしている（入力欄に残ったまま未送信）場合は、再度 Enter のみを送る。

```bash
# 1. メッセージ送信
tmux send-keys -t cw:0.0 "メッセージ内容"
# 2. Enter送信
tmux send-keys -t cw:0.0 Enter
# 3. 5秒待機後に到達確認（sleep 5 → tmux capture-pane で確認、または wire_receive で返信確認）
```

> ccwire MCPが使える場合は、tmux send-keys ではなく `wire_send` を使うこと。構造化された通信ができ、配信保証もある。

## 注意事項

- セッションは24時間で自動的に期限切れになる
- SQLite WAL モードで同時アクセスを安全に処理
- ブロードキャストは送信元には配信されない
