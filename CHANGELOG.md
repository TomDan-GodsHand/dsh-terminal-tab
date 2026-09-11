# Changelog

All notable changes to this plugin are recorded here. Versions are plain semver
(`<major>.<minor>.<patch>`), and each release is tagged `v<version>` — for example `v1.0.0`.

## [1.0.0] - 2026-09-11

First release. Everything below shipped together, because the plugin was developed against a live
DSH web GUI before it had a repository.

### Added

- **终端 tab** beside 对话 and 轨迹, contributed to the `conversation.view` slot (`id: 'terminal'`,
  `order: 20`) — one terminal process per session, surviving a page reload or a tab switch for the
  host's reconnect grace period.
- **Terminal transport**: one WebSocket route (`/terminal-tab/ws`) carrying raw terminal bytes over
  `node-pty` (ConPTY on Windows), with a transcript replayed to a reconnecting browser, `resize` /
  `close` / `park` control frames, and a loopback/cross-site trust fence in front of it.
- **Settings page** (设置 / 插件 / 插件设置 → **Terminal**), keyed to the host settings namespace
  `dsh-terminal-tab`: shell (`auto` / `pwsh` / `powershell` / `cmd` / `bash` / a path), start-up
  command, font family, font size, and the full palette.
- **Staged editing** matching the page's own plugin cards: controls write to a draft, the header
  marks it 未保存, and only 保存 writes — as a path-addressed diff, so a redacted settings view
  cannot lose fields it never saw.
- **Editable HEX** next to every swatch (`#aabbcc`, `aabbcc`, `#abc`), with a live preview strip.
- **Self-check** at `/terminal-tab/diagnostics`: which build this process loaded, whether its
  content hash still matches the file on disk, and whether the package row is in the client module
  graph the page boots from.

### Changed

- Default palette is **white-background** (`#ffffff`) with the darker end of each ANSI hue, so every
  colour stays legible on white.
- The terminal owns the whole view: the toolbar and the page padding were removed, and the resident
  composer plus its two width handles are hidden while the terminal tab is active.

### Fixed

- The bound settings hook is called with a selector. Calling it without one forwarded `undefined` to
  `useSyncExternalStoreWithSelector`, which crashed both slot entries at render with
  `TypeError: l is not a function`.
- CSS token names corrected to the ones the GUI actually declares (`--dsw-alias-label-*`,
  `--dsw-alias-bg-layer-*`); the earlier invented names silently fell back.
- xterm paints the configured background: `allowTransparency` was letting the page show through.
- The self-check compares content hashes rather than modification times, so reinstalling an identical
  build no longer reports a staleness that is not there.
