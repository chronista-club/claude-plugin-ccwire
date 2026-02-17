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

## アーキテクチャ

```
CC Session A ◄──► ccwire MCP ──┐
CC Session B ◄──► ccwire MCP ──┤──► ~/.cache/ccwire/ (共有ストア)
CC Session C ◄──► ccwire MCP ──┘
```

プラグイン導入だけで動作。外部サービス不要。

## MCP ツール

| ツール | 説明 |
|--------|------|
| `wire_register` | セッション登録 |
| `wire_send` | メッセージ送信 |
| `wire_receive` | 未読メッセージ取得 |
| `wire_broadcast` | 全体ブロードキャスト |
| `wire_sessions` | セッション一覧 |
| `wire_status` | ステータス更新/取得 |
| `wire_ack` | 受信確認 |

## 要件

- Bun >= 1.0
- Claude Code with plugin support

## ライセンス

MIT
