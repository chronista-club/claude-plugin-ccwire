---
description: 特定のセッションにメッセージを送信する
allowed-tools: mcp__ccwire__wire_send, mcp__ccwire__wire_sessions
---

# /wire-send

ユーザーがCC間メッセージを手動で送信するためのコマンド。

## 使い方

```
/wire-send <session> <message>
```

## 手順

1. 引数が指定されていない場合は、`wire_sessions` で利用可能なセッション一覧を表示し、送信先と内容を確認する
2. `wire_send` で指定されたセッションにメッセージを送信する
3. 送信結果をユーザーに報告する

引数 `$ARGUMENTS` を解析してください:
- 第1引数: 送信先セッション名
- 第2引数以降: メッセージ内容

メッセージタイプはデフォルトで `task_request` を使用する。
