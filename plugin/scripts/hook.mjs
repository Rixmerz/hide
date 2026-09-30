// Hook entry point: `node hook.mjs <prompt|session|pretool>`, event JSON on stdin.
//
// prompt   UserPromptSubmit. A prompt holding a secret is blocked (exit 2),
//          so it never reaches the model or the transcript. A side pane asks
//          for a variable name, the value goes to the keychain, and a clean
//          copy of the prompt, with `$NAME` in place of the secret, lands on
//          the clipboard to be sent again.
// session  SessionStart. Tells Claude which secret names exist and how to use them.
// pretool  PreToolUse on Bash. Denies commands that print a keychain value.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { detectSecrets, preview, replaceAll } from '../lib/detect.mjs';
import { saveSecret, readIndex } from '../lib/store.mjs';
import { openPane } from '../lib/pane.mjs';
import { scrubClaudeFiles } from '../lib/scrub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HIDE_BIN = join(HERE, '..', 'bin', 'hide');
const WAIT_MS = Number(process.env.HIDE_WAIT_SECONDS ?? 280) * 1000;

function usage(names) {
  const list = names.map((n) => `$${n}`).join(', ');
  return [
    `hide: these secrets are stored in the OS keychain: ${list}.`,
    `You cannot see their values and must not try to (no keychain reads, no printing them).`,
    `To use one, run the command through hide, which injects it as an environment variable and masks it in the output:`,
    `  hide exec NAME [NAME...] -- 'curl -H "Authorization: Bearer $NAME" https://...'`,
    `A single quoted command runs under sh -c, so $NAME expands inside it. hide is on your PATH; its absolute path is ${HIDE_BIN}.`,
    `\`hide list\` shows the stored names. To store a new secret, ask the user to paste it in a prompt: hide intercepts it.`,
  ].join('\n');
}

function emit(event, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...extra } }));
}

// Set once a prompt is known to hold a secret: from then on any failure
// must block it rather than let it through.
let holdsSecret = false;

function copyToClipboard(text) {
  const tools = {
    darwin: [['pbcopy', []]],
    win32: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())']]],
  }[process.platform] ?? [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  return tools.some(([cmd, args]) => spawnSync(cmd, args, { input: text }).status === 0);
}

// history.jsonl may be appended after this hook returns, so the scrub runs
// again from a detached process. Secrets reach it over a pipe, not argv.
function scrubLater(pairs, transcriptPath) {
  const child = spawn(process.execPath, [join(HERE, 'rescrub.mjs')], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(JSON.stringify({ pairs, transcriptPath }));
  child.unref();
}

async function waitForAnswer(dir) {
  const file = join(dir, 'answer.json');
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    await sleep(200);
  }
  return { cancel: true, timedOut: true };
}

function referencedNames(prompt) {
  const index = readIndex();
  const words = new Set(prompt.match(/[A-Z_][A-Z0-9_]*/g) ?? []);
  return Object.keys(index).filter((n) => words.has(n));
}

async function onPrompt(event) {
  const prompt = event.prompt ?? '';
  const found = detectSecrets(prompt);

  if (found.length === 0) {
    const names = referencedNames(prompt);
    if (names.length) emit('UserPromptSubmit', { additionalContext: usage(names) });
    return;
  }

  holdsSecret = true;
  const summary = found.map((s) => `${s.kind} ${preview(s.value)}`).join(', ');
  const dir = mkdtempSync(join(tmpdir(), 'hide-'));
  try {
    const request = {
      candidates: found.map((s) => ({ preview: preview(s.value), kind: s.kind, suggested: s.suggested })),
      existing: Object.keys(readIndex()),
    };
    writeFileSync(join(dir, 'request.json'), JSON.stringify(request), { mode: 0o600 });
    const pane = openPane(dir, [process.execPath, join(HERE, 'ask.mjs'), dir]);
    const answer = pane ? await waitForAnswer(dir) : { cancel: true, noPane: true };

    if (!answer.cancel && answer.names.every((n) => n === null)) {
      holdsSecret = false; // every match was a false positive: let the prompt through
      return;
    }

    const stored = [];
    let clean = prompt;
    for (const [i, secret] of found.entries()) {
      const name = answer.cancel ? null : answer.names[i];
      if (name) {
        saveSecret(name, secret.value, { kind: secret.kind });
        stored.push(name);
      }
      clean = replaceAll(clean, secret.value, name ? `$${name}` : '[hide:REDACTED]');
    }
    const pairs = found.map((s, i) => [s.value, (!answer.cancel && answer.names[i]) || 'REDACTED']);
    scrubClaudeFiles(pairs, { transcriptPath: event.transcript_path });
    scrubLater(pairs, event.transcript_path);

    if (answer.cancel) {
      const why = answer.noPane
        ? `could not open a side terminal. Store it yourself from any terminal with:\n  ${HIDE_BIN} add NAME\nthen write $NAME in your prompt instead of the value.`
        : 'no name was given, nothing was stored.';
      return `hide: blocked a prompt holding a secret (${summary}). Claude did not see it. ${why}`;
    }
    const copied = copyToClipboard(clean);
    return [
        `hide: stored ${stored.map((n) => `$${n}`).join(', ')} in the keychain. Claude did not see the secret.`,
        copied
          ? 'The prompt was held back; a clean copy with the variable names is on your clipboard. Paste it and send.'
          : 'The prompt was held back. Send it again writing the variable name instead of the value.',
    ].join('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function onSession() {
  const names = Object.keys(readIndex());
  if (names.length) emit('SessionStart', { additionalContext: usage(names) });
}

// Reading a value back is exactly what `hide exec` exists to avoid.
const REVEAL = [
  /\bsecurity\b[^|;&\n]*\bfind-(?:generic|internet)-password\b[^|;&\n]*\s-[a-zA-Z]*[wg]\b/,
  /\bsecurity\b[^|;&\n]*\bdump-keychain\b[^|;&\n]*\s-[a-zA-Z]*d\b/,
  /\bsecret-tool\s+lookup\b/,
  /\bUnprotect\b/i,
  /\bhide[/\\]+(?:secrets\b|test-store\.json\b)/,
];

function onPreTool(event) {
  const command = event.tool_input?.command ?? '';
  if (!REVEAL.some((re) => re.test(command))) return;
  emit('PreToolUse', {
    permissionDecision: 'deny',
    permissionDecisionReason:
      'hide: this command would print a keychain secret. Use `hide exec NAME -- <command>` so the value is injected as $NAME without being shown.',
  });
}

const HANDLERS = { prompt: onPrompt, session: onSession, pretool: onPreTool };

async function main() {
  const handler = HANDLERS[process.argv[2]];
  if (!handler) throw new Error(`hide hook: unknown mode "${process.argv[2]}"`);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return handler(event);
}

// Exit 2 on UserPromptSubmit blocks the prompt and shows stderr to the user.
try {
  const blockMessage = await main();
  if (blockMessage) {
    process.stderr.write(`${blockMessage}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  // Fail closed for a prompt holding a secret; any other failure must not
  // break Claude Code.
  process.stderr.write(`hide: ${error.message}\n`);
  process.exitCode = holdsSecret ? 2 : 0;
}
