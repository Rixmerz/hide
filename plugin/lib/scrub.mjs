// Claude Code keeps what the user typed outside the conversation too: short
// pastes and typed text land in ~/.claude/history.jsonl (the up-arrow
// history), long pastes in ~/.claude/paste-cache/<hash>.txt. Blocking the
// prompt keeps the secret from the model, not from those files, so they are
// rewritten with the secret replaced by its label.

import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RECENT_MS = 60 * 60 * 1000;

function rewrite(file, pairs) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false; // missing or unreadable: nothing to scrub
  }
  let out = text;
  for (const [from, to] of pairs) out = out.replaceAll(from, to);
  if (out === text) return false;
  const tmp = `${file}.hide-${process.pid}.tmp`;
  writeFileSync(tmp, out, { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
  return true;
}

// `secrets` is [[value, name]]. JSONL files hold the value JSON-escaped (a PEM
// key's newlines become \n), so both spellings are replaced.
export function scrubClaudeFiles(secrets, { claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), transcriptPath } = {}) {
  const raw = secrets.map(([value, name]) => [value, `[hide:${name}]`]);
  const escaped = secrets.map(([value, name]) => [JSON.stringify(value).slice(1, -1), `[hide:${name}]`]);
  const jsonPairs = [...escaped, ...raw];
  const touched = [];

  for (const file of [join(claudeDir, 'history.jsonl'), transcriptPath].filter(Boolean)) {
    if (rewrite(file, jsonPairs)) touched.push(file);
  }

  const cache = join(claudeDir, 'paste-cache');
  let names = [];
  try {
    names = readdirSync(cache);
  } catch {
    names = []; // no paste cache yet
  }
  const now = Date.now();
  for (const name of names) {
    const file = join(cache, name);
    try {
      if (now - statSync(file).mtimeMs > RECENT_MS) continue;
    } catch {
      continue; // removed while we were listing
    }
    if (rewrite(file, raw)) touched.push(file);
  }
  return touched;
}
