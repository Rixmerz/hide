---
name: hide
description: Use a secret (API key, token, password, connection string) that the user stored with hide, without ever seeing its value. Use whenever a prompt or the session context mentions a hide secret name like $OPENAI_API_KEY, when a command needs a credential, or when the user asks to store, list or delete a secret.
---

# Using secrets stored with hide

The user's secrets live in the OS keychain (macOS Keychain, Linux Secret Service, Windows DPAPI). You only know their **names**. Never try to learn a value.

## Run a command with a secret

```bash
hide exec OPENAI_API_KEY -- 'curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"'
```

- Names go before `--`; each becomes an environment variable of the command.
- A single quoted argument runs under `sh -c`, so `$NAME` expands **inside** it. Outside single quotes your own shell would expand it to an empty string first.
- Without quotes, argv is run directly: `hide exec GH_TOKEN -- gh repo list` (tools that read the variable themselves).
- Output is masked: the value, its base64 and URL-encoded forms and, for multi-line secrets, each line are replaced with `[hide:NAME]`.

## Other commands

- `hide list` shows stored names, their kind and date.
- `hide rm NAME` deletes one.
- There is no command that prints a value, and commands that read the keychain directly are denied by a hook.

## Rules

- Never write a secret value into a file, a commit, a command line or your reply. Refer to it as `$NAME`.
- An app that needs the value in a `.env` file: write `NAME=` placeholders and tell the user to run the app through `hide exec NAME -- <start command>` instead.
- To store a new secret, ask the user to paste it in a prompt: hide intercepts the prompt before you see it and asks them for a name. Never ask the user to paste a secret any other way.
- Masking catches the exact value and the encodings above, not arbitrary transformations. Do not transform a secret in a way that could print it (hashing, slicing, reversing, re-encoding).
