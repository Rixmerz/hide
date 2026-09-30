# Changelog

## 0.2.0 — 2026-09-30

- The clean prompt is sent back into Claude's input automatically in tmux, WezTerm and iTerm2 (bracketed paste + Enter), instead of only landing on the clipboard.
- Keys glued to the previous word (`pruebask-proj-…`) are detected: prefix rules no longer require a word boundary before the prefix.
- High-entropy fallback for token formats no rule knows.
- Values marked `skip` are remembered for 24 hours (SHA-256 only), so a resent prompt or a repeated false positive does not open the pane again.

## 0.1.0 — 2026-09-30

- First release: UserPromptSubmit block, side pane for the name, OS keychain storage (macOS Keychain, Linux Secret Service, Windows DPAPI), `hide exec` with output masking, PreToolUse guard, scrubbing of Claude Code's history and paste cache.
