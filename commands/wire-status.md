---
description: 全セッションのステータスを表示する
allowed-tools: mcp__ccwire__wire_status, mcp__ccwire__wire_sessions
---

# /wire-status

全セッションのステータスを一覧表示する。

## 手順

1. `wire_sessions` で接続中セッション一覧を取得
2. `wire_status` で各セッションのステータスを取得
3. 見やすいテーブル形式でユーザーに表示する

## 表示フォーマット

```
| セッション | ステータス | 最終更新 |
|-----------|----------|---------|
| nexus-main ★ | idle | 2m ago |
| issue-2 | busy | 30s ago |
```

★ は自分のセッションを示す。
