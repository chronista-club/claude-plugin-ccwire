# ccwire セッション自動登録・自動解除

## 背景

現状の問題:
- SessionStart 時に手動で `wire_register` を呼ぶ必要がある
- SessionEnd 時の unregister がない（24時間TTLで自然消滅を待つのみ）
- セッションが溜まり続ける

将来の展望:
- vantage-point の独自プロセス管理上で動く CC 同士のメッセージング基盤として ccwire を使う
- プロセス管理側が CC を起動する際にセッション名を注入する

## 設計

### 環境変数契約

```
CCWIRE_SESSION_NAME  — セッション名（必須。なければ自動登録しない）
CCWIRE_TMUX_TARGET   — tmux ターゲット（任意。あればtmux通知有効化）
```

プロセス管理側（cw, vantage-point 等）がこの環境変数をセットして CC を起動する。
ccwire プラグインはこの環境変数の存在だけに依存し、プロセス管理の実装詳細は知らない。

### 変更一覧

#### 1. `wire_unregister` MCP ツール追加（server.ts）

sessions.json から指定セッションを削除し、関連メッセージディレクトリもクリーンアップする。

```typescript
// パラメータ
{ name?: string }  // 省略時は currentSessionName を使う
```

#### 2. SessionStart フック（hooks/register.sh）

```bash
#!/bin/bash
# CCWIRE_SESSION_NAME が設定されていれば sessions.json に直接登録
if [ -z "$CCWIRE_SESSION_NAME" ]; then
  # 環境変数なし → 従来通りガイドメッセージ
  echo '{"additionalContext": "## ccwire-protocol\n\n..."}'
  exit 0
fi

# sessions.json にエントリを追加（ファイルロック付き）
# tmux_target は CCWIRE_TMUX_TARGET から取得
```

#### 3. SessionEnd フック（hooks/unregister.sh）

```bash
#!/bin/bash
# CCWIRE_SESSION_NAME があれば sessions.json から削除
if [ -z "$CCWIRE_SESSION_NAME" ]; then
  exit 0
fi

# sessions.json からエントリを削除
```

#### 4. hooks.json 更新

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "..." }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "..." }] }],
    "UserPromptSubmit": [/* 既存のまま */]
  }
}
```

### ファイルロック

シェルスクリプトからの sessions.json 書き込みは server.ts と同じロックファイル（`~/.cache/ccwire/lock`）を使う。
`mkdir` ベースのロックで排他制御し、stale ロック（10秒超）は自動除去。

### フォールバック

| 条件 | 動作 |
|------|------|
| `CCWIRE_SESSION_NAME` あり | 自動登録 → 自動解除 |
| `CCWIRE_SESSION_NAME` なし | 従来通り手動 `wire_register` |
