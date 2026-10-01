# hide

Keeps secrets out of Claude Code's context. When a prompt contains an API key, token, private key or credential URL, hide stops the prompt before the model sees it. A terminal pane opens next to Claude and asks you to name the secret. The value goes to your OS keychain, the prompt is sent again with `$NAME` in place of the value, and Claude gets only the variable name and a command that runs with it.

```
you   > call the API with sk-proj-…
hide  │ blocks the prompt (Claude sees nothing)
      │ opens a side pane:  Variable name [OPENAI_API_KEY]: ⏎
      │ stores the value in the keychain
      │ sends "call the API with $OPENAI_API_KEY" back into Claude's input
claude> hide exec OPENAI_API_KEY -- 'curl … -H "Authorization: Bearer $OPENAI_API_KEY"'
        output: … [hide:OPENAI_API_KEY] …
```

## Install

```
/plugin marketplace add Rixmerz/claude-plugins
/plugin install hide@rixmerz
```

Or directly from this repo: `/plugin marketplace add Rixmerz/hide`, then `/plugin install hide@hide`.

Requires Node 20+. On Linux, install `secret-tool` (`libsecret-tools` on Debian/Ubuntu, `libsecret` on Fedora/Arch).

## Where secrets are stored

Secrets are **encrypted, not hashed**. A hash can't be reversed, and an API key has to be sent in plain text to the service that issued it. So the storage is the OS's own encrypted store, unlocked by your login:

| OS | Store | Location |
|---|---|---|
| macOS | Keychain (`security`) | login keychain, service `hide`, account `NAME` |
| Linux | Secret Service (`secret-tool`: GNOME Keyring, KWallet) | attributes `service=hide account=NAME` |
| Windows | DPAPI, current-user scope (the key Credential Manager uses) | `%LOCALAPPDATA%\hide\secrets\NAME.bin` |

Values never go through a command line, where `ps` could see them. They go over stdin. On macOS the keychain item holds the value base64-encoded, so multi-line values such as PEM keys come back intact.

`~/.config/hide/index.json` (`%LOCALAPPDATA%\hide\index.json` on Windows) lists names, kinds and dates, never values. That way the SessionStart hook can tell Claude what exists without touching the keychain.

## What each piece does

| Piece | Event | Job |
|---|---|---|
| `scripts/hook.mjs prompt` | UserPromptSubmit | detects secrets, blocks the prompt (exit 2), opens the name pane, stores, resends the clean prompt, scrubs Claude Code's local files; for a prompt that mentions a stored `$NAME`, adds usage instructions to Claude's context |
| `scripts/hook.mjs session` | SessionStart | tells Claude which names exist and how to use them |
| `scripts/hook.mjs pretool` | PreToolUse (Bash, PowerShell) | denies commands that would print a keychain value (`security find-generic-password -w`, `secret-tool lookup`, DPAPI `Unprotect`, …) |
| `bin/hide` | on Claude's PATH | `hide exec NAME… -- cmd`, `hide list`, `hide add NAME`, `hide rm NAME` |
| `skills/hide` | skill | how Claude should use secrets |

### The side pane

It opens in the first of these that applies: **tmux** (split), **WezTerm** (split), **iTerm2** (vertical split of the exact session running Claude), **Orca** (split of the terminal running Claude, through its `orca` CLI; macOS and Linux), **Windows Terminal** (split), a new **Terminal.app** window, a new **Windows console**, or a Linux terminal (`x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`). The pane only gets masked previews (`sk-pro…ake1 (68 chars)`), never the value.

For each match you can accept the suggested name, type another, or type `skip` if it isn't a secret. If you skip every match, the prompt goes through unchanged. A skipped value is remembered for 24 hours (only its SHA-256, in `allowed.json` next to the index), so the same false positive does not open the pane again. If you close the pane or wait out the 280-second limit, the prompt stays blocked and nothing is stored.

If no pane can be opened, the prompt stays blocked and hide tells you how to store the secret yourself:
`<plugin>/bin/hide add NAME` (the value is read at a hidden prompt, or from stdin).

### Sending the prompt again

A UserPromptSubmit hook can block a prompt but cannot rewrite it, so the clean copy has to be submitted as a new prompt. In **tmux**, **WezTerm**, **iTerm2** and **Orca**, hide types it back into the exact pane Claude runs in, as a bracketed paste (so a multi-line prompt is not cut at its first newline), and presses Enter. It does this about 1 second after the block, once Claude Code is waiting for input again. Everywhere else (Terminal.app, Windows Terminal, VS Code, Linux terminals) the clean prompt goes to the clipboard: paste it and send. Set `HIDE_RESEND=0` to always use the clipboard.

### Detected formats

Private key blocks, Anthropic, OpenAI, AWS access key IDs, GitHub, GitLab, Slack tokens and webhooks, Google API keys, Stripe, npm, Sonar, Hugging Face, Groq, xAI, JWTs, `Bearer …` headers, URLs with `user:password@`, and assignments like `DB_PASSWORD=…` or `api_key: "…"`. For an assignment, the variable name written in the prompt becomes the suggestion. Placeholders (`changeme`, `<your-key>`, `${VAR}`, `xxxx`) are ignored.

Keys are caught even when glued to the previous word (`pruebask-proj-…`), since rules with a distinctive prefix do not require a word boundary before it. A key glued to the **next** word can't be told apart from it, so the pane shows the match's length and last characters to check.

As a last resort, any run of 32 or more token characters that mixes upper case, lower case and at least 3 digits, with Shannon entropy of at least 4 bits per character, is flagged as `high-entropy` (suggested name `SECRET`). Hex digests, UUIDs, paths, URLs and long identifiers don't qualify.

### Local files Claude Code keeps

Blocking the prompt keeps the secret from the model and the transcript, but Claude Code also saves what you type in `~/.claude/history.jsonl` (the up-arrow history) and long pastes in `~/.claude/paste-cache/`. hide replaces the secret with `[hide:NAME]` in both, in the session transcript, and again 1.5 s, 5 s and 20 s later, in case Claude Code writes history after the hook returns. `CLAUDE_CONFIG_DIR` is honored.

## Limits

- **Your own screen still shows it.** Claude Code prints the blocked prompt ("Original prompt: …") in your terminal. The model never receives it.
- **Masking matches, it doesn't understand.** `hide exec` masks the exact value, its base64 and URL-encoded forms and each line of a multi-line secret. A command that transforms the value some other way (reversing it, hashing it, printing a slice) can still reveal it. Together with the PreToolUse guard and the skill's rules, this stops accidental exposure. It is not a sandbox against a model trying to exfiltrate. On macOS, any process running as you can read the item through `security`.
- **Detection is pattern-based.** A secret in an unknown format with no `*_KEY=`/`*_TOKEN=`-style name next to it won't be caught. Add it with `hide add NAME` instead of pasting it.
- **The clipboard** receives the clean prompt, which has no secrets in it, on terminals where it can't be resent.
- **The resend types into your terminal.** If you start typing in Claude's input within that second, your text and the resent prompt get mixed.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HIDE_SERVICE` | `hide` | keychain service name |
| `HIDE_WAIT_SECONDS` | `280` | how long the hook waits for the pane (the hook timeout is 300) |
| `HIDE_PANE` | – | `none` to never open a pane |
| `HIDE_RESEND` | – | `0` to never type the clean prompt back; use the clipboard |
| `HIDE_BACKEND` | per OS | `keychain`, `secret-service`, `dpapi`; `plaintext-file-for-tests` exists only for the test suite |

## Development

```
pnpm test           # node --test, no dependencies
claude --plugin-dir ./plugin
```

The fixtures in `test/fixtures.mjs` are assembled at runtime from an obvious `FAKE…` filler, so no literal in the repo looks like a real credential.

## License

Apache-2.0
