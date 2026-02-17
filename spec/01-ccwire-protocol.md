# ccwire-protocol 仕様書

> CC間通信プロトコル v0.1.0

## 概要

ccwire-protocolは、同一マシン上で並行稼働する複数のClaude Code（CC）セッション間でメッセージを交換するためのプロトコルを定義する。

### 解決する課題

- CC間通信にプロトコルがない（何を送るか、どう受け取るか未定義）
- 配信保証なし、ステータス確認不可
- セッション発見の仕組みがない

### 設計方針

- **プラグイン導入だけで使える**: 外部サービス不要
- **ファイルベース共有ストア**: 各MCPプロセスが`~/.cache/ccwire/`を通じて通信
- **シンプルなライフサイクル**: register → send/receive → ack

---

## アーキテクチャ

```
CC Session A ◄──► ccwire MCP (stdio, PID 100) ──┐
CC Session B ◄──► ccwire MCP (stdio, PID 200) ──┤──► ~/.cache/ccwire/ (共有ストア)
CC Session C ◄──► ccwire MCP (stdio, PID 300) ──┘
```

### stdio型MCPの制約と対処

各CCセッションは独自のMCPサーバープロセスを起動する（stdio型のため）。プロセス間でメモリ共有はできないため、ファイルシステムを共有ストアとして使用する。

### 共有ストア構造

```
~/.cache/ccwire/
├── sessions.json          # セッション登録情報
├── messages/              # メッセージキュー
│   ├── <session-name>/    # セッション宛メッセージ
│   │   ├── msg-<uuid>.json
│   │   └── msg-<uuid>.json
│   └── broadcast/         # ブロードキャストメッセージ
│       └── msg-<uuid>.json
└── lock                   # ファイルロック
```

### 排他制御

- `lock`ファイルによるファイルベースロック
- `writeFile`の`wx`フラグ（排他的作成）で実現
- 10秒以上のstaleロックは自動解除
- 最大50回リトライ（100ms間隔）

---

## プロトコル

### セッション

セッションはCCの作業単位を表す。名前は自由に設定可能。

```typescript
interface Session {
  name: string;           // セッション識別名
  tmux_target?: string;   // tmuxターゲット（省略可）
  status: "idle" | "busy" | "done";
  registered_at: string;  // ISO 8601
  last_seen: string;      // ISO 8601
}
```

- TTL: 24時間（last_seenから計算）
- 同名で再登録すると`last_seen`が更新される

### メッセージ

```typescript
interface Message {
  id: string;             // "msg-<uuid>"
  from: string;           // 送信元セッション名
  to: string;             // 送信先セッション名（"*" = broadcast）
  type: MessageType;
  content: string;        // メッセージ本文
  timestamp: string;      // ISO 8601
  reply_to: string | null; // 返信先メッセージID
  status: "pending" | "delivered" | "acknowledged";
}
```

### メッセージタイプ

| type | 用途 | 方向 |
|------|------|------|
| `task_request` | タスク依頼 | 1:1 |
| `response` | 返答・報告 | 1:1 |
| `broadcast` | 全体通知 | 1:N |
| `ack` | 受信確認 | 1:1 |
| `status_update` | ステータス変更通知 | 1:1 |

### メッセージライフサイクル

```
pending → delivered → acknowledged
  │          │
  │          └─ wire_receive() で取得時
  └─ wire_send() で作成時
```

---

## MCP ツール仕様

### wire_register

セッションを登録する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `name` | string | ✅ | セッション名 |
| `tmux_target` | string | - | tmuxターゲット |

### wire_send

特定セッションにメッセージを送信する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `to` | string | ✅ | 送信先セッション名 |
| `content` | string | ✅ | メッセージ内容 |
| `type` | enum | - | メッセージタイプ（default: task_request） |
| `reply_to` | string | - | 返信先メッセージID |

### wire_receive

自分宛の未読メッセージを取得する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `limit` | number | - | 取得上限（default: 10） |

### wire_broadcast

全セッションに一斉送信する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `content` | string | ✅ | ブロードキャスト内容 |

### wire_sessions

接続中セッション一覧を取得する（パラメータなし）。

### wire_status

ステータスの更新または全体取得。

| パラメータ | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `status` | enum | - | 設定値。省略で全体取得 |

### wire_ack

メッセージの受信確認。

| パラメータ | 型 | 必須 | 説明 |
|-----------|---|------|------|
| `message_id` | string | ✅ | 確認するメッセージID |

---

## セキュリティ考慮

- ローカルマシン上のファイルシステムのみ使用（ネットワーク通信なし）
- ユーザーのファイル権限に依存（マルチユーザー環境では注意）
- メッセージに機密情報を含めないことを推奨

---

## 制限事項

- 同一マシン上のCCセッション間のみ対応
- リアルタイム通知なし（ポーリング方式）
- メッセージの暗号化なし
- セッションTTLは24時間固定
