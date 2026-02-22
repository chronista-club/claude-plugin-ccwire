# ccwire - CC間通信プロトコル

複数のClaude Codeセッション間でリアルタイムにメッセージをやり取りするためのプラグイン。

## インストール

```bash
/plugin install ccwire@chronista-plugins
```

## 使い方

### 1. セッション登録

各CCセッションで最初に実行:

```
wire_register でセッション名 "my-session" を登録して
```

### 2. メッセージ送受信

```
# 送信
wire_send で "issue-2" に「認証モジュールをリファクタリングして」と送って

# 受信
wire_receive で未読メッセージを確認して
```

### 3. コマンド

| コマンド | 説明 |
|---------|------|
| `/wire-send <session> <message>` | メッセージ送信 |
| `/wire-status` | 全セッションのステータス表示 |
| `/wire-sessions` | 接続中セッション一覧 |

## 自動登録（環境変数）

プロセス管理側が以下の環境変数をセットすると、SessionStart フックで自動登録される:

| 環境変数 | 必須 | 説明 |
|----------|------|------|
| `CCWIRE_SESSION_NAME` | Yes | セッション名（例: `worker-issue-42`） |
| `CCWIRE_TMUX_TARGET` | No | tmuxターゲット（例: `cw-parallel:0.0`）。通知送信に使用 |

自動登録時は `wire_register` の手動呼び出しは不要。ただしMCPプロセスの `currentSessionName` を同期するため、会話の最初に一度だけ `wire_register(name="セッション名")` を実行する。

環境変数が未設定の場合は従来通り手動 `wire_register` が必要。

### フック

| フック | 動作 |
|--------|------|
| SessionStart | `CCWIRE_SESSION_NAME` があれば自動登録 |
| UserPromptSubmit | 未読メッセージがあれば通知を表示 |
| SessionEnd | `CCWIRE_SESSION_NAME` があれば自動 unregister |

## メッセージタイプ

`wire_send` の `type` パラメータで指定:

| type | 用途 |
|------|------|
| `task_request` | タスク依頼（デフォルト） |
| `response` | 返答・報告 |
| `status_update` | ステータス変更通知 |
| `question` | 質問・確認 |
| `health_ping` | ヘルスチェック |
| `conflict_warning` | コンフリクト警告 |

## アーキテクチャ

```
CC Session A <--> ccwire MCP --+
CC Session B <--> ccwire MCP --+--> ~/.cache/ccwire/ccwire.db (SQLite WAL)
CC Session C <--> ccwire MCP --+
```

各CCセッションが独自のMCPサーバープロセスを起動し、SQLite DB を通じてメッセージを交換する。WALモードにより複数プロセスからの同時アクセスに対応。プラグイン導入だけで動作。外部サービス不要。

## MCP ツール

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

## 要件

- Bun >= 1.0
- Claude Code with plugin support

## ライセンス

MIT
