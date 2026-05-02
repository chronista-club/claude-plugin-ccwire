# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.9.5] - 2026-05-02

### Fixed
- `plugin.json` の `mcpServers` field を削除 (string path は公式 spec 不一致、 `mcpServers: Invalid input` で install 失敗)
- `.mcp.json` は plugin root に存在し Claude Code が auto-discover、 plugin.json での参照は不要

### Note
- v0.9.4 は published tag だが install 不可、 0.9.5 として fix release

## [0.9.4] - 2026-05-02

### Changed
- Spec compliance pass: separated mcpServers to .mcp.json, added license/homepage fields
