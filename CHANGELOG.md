# Changelog

## 0.4.0 — 2026-10-03

- In-app pane on Claude Code builds with function hooks (`hooks/hide.tsx`): a prompt holding a secret is dropped at `prompt.submit` and named in a pane inside Claude Code, instead of a side terminal. The clean prompt is submitted again as the user's own words, with no keystroke injection or clipboard, and the transcript row never shows the value.
- Cancel in the pane puts the prompt back in the input with the secret redacted, so it can be edited and sent.
- `/hide` lists the stored names.
- The classic UserPromptSubmit hook stays as the fallback for headless runs, prompts with images, older builds, and anything the pane can't handle.

## 0.3.0 — 2026-10-01

- Orca: the name pane opens as a split next to Claude's terminal (`orca terminal split`) and the clean prompt is sent back into it (`orca terminal send`), instead of opening a separate Terminal.app window and using the clipboard.

## 0.2.0 — 2026-09-30

- The clean prompt is sent back into Claude's input automatically in tmux, WezTerm and iTerm2 (bracketed paste + Enter), instead of only landing on the clipboard.
- Keys glued to the previous word (`pruebask-proj-…`) are detected: prefix rules no longer require a word boundary before the prefix.
- High-entropy fallback for token formats no rule knows.
- Values marked `skip` are remembered for 24 hours (SHA-256 only), so a resent prompt or a repeated false positive does not open the pane again.

## 0.1.0 — 2026-09-30

- First release: UserPromptSubmit block, side pane for the name, OS keychain storage (macOS Keychain, Linux Secret Service, Windows DPAPI), `hide exec` with output masking, PreToolUse guard, scrubbing of Claude Code's history and paste cache.
