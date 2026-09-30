// End-to-end over the real entry points (hook.mjs and bin/hide), with the
// test-only file backend and a throwaway config, temp and Claude dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakes } from './fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const HOOK = join(ROOT, 'scripts', 'hook.mjs');
const HIDE = join(ROOT, 'bin', 'hide');

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'hide-e2e-'));
  for (const d of ['config', 'tmp', 'claude']) mkdirSync(join(base, d));
  return {
    base,
    env: {
      ...process.env,
      HIDE_BACKEND: 'plaintext-file-for-tests',
      XDG_CONFIG_HOME: join(base, 'config'),
      LOCALAPPDATA: join(base, 'config'),
      TMPDIR: join(base, 'tmp'),
      CLAUDE_CONFIG_DIR: join(base, 'claude'),
      HIDE_PANE: 'none',
      HIDE_WAIT_SECONDS: '10',
      // Never type into the terminal running the tests.
      HIDE_RESEND: '0',
      TMUX: '',
      TMUX_PANE: '',
      WEZTERM_PANE: '',
      ITERM_SESSION_ID: '',
      TERM_PROGRAM: '',
    },
  };
}

function runSync(args, env, input = '') {
  return spawnSync(process.execPath, args, { env, input, encoding: 'utf8' });
}

function hookEvent(prompt, extra = {}) {
  return JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: 's', ...extra });
}

test('a prompt without secrets passes with no output', () => {
  const { env } = sandbox();
  const r = runSync([HOOK, 'prompt'], env, hookEvent('refactor the login page'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('with no pane available the prompt is blocked and history is scrubbed', () => {
  const { env, base } = sandbox();
  const history = join(base, 'claude', 'history.jsonl');
  const prompt = `call the api with ${fakes.openaiProject}`;
  writeFileSync(history, JSON.stringify({ display: prompt }) + '\n');

  const r = runSync([HOOK, 'prompt'], env, hookEvent(prompt));

  assert.equal(r.status, 2);
  assert.match(r.stderr, /Claude did not see it/);
  assert.ok(!r.stderr.includes(fakes.openaiProject), 'the block message must not echo the secret');
  assert.ok(!readFileSync(history, 'utf8').includes(fakes.openaiProject));
});

async function answerFromPane(base, answer) {
  const tmp = join(base, 'tmp');
  for (let i = 0; i < 100; i++) {
    const dir = readdirSync(tmp).find((d) => d.startsWith('hide-'));
    if (dir && existsSync(join(tmp, dir, 'request.json'))) {
      const request = JSON.parse(readFileSync(join(tmp, dir, 'request.json'), 'utf8'));
      writeFileSync(join(tmp, dir, 'answer.json'), JSON.stringify(answer));
      return request;
    }
    await sleep(50);
  }
  throw new Error('hook never wrote request.json');
}

function runHookAsync(env, input) {
  const child = spawn(process.execPath, [HOOK, 'prompt'], { env: { ...env, HIDE_PANE: 'external' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(input);
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
}

test('naming the secret stores it and the CLI can use it without printing it', async () => {
  const { env, base } = sandbox();
  const hook = runHookAsync(env, hookEvent(`deploy with GH_TOKEN=${fakes.github}`));
  const request = await answerFromPane(base, { names: ['GH_TOKEN'] });
  const r = await hook;

  assert.equal(request.candidates[0].suggested, 'GH_TOKEN');
  assert.ok(!JSON.stringify(request).includes(fakes.github), 'the pane must only get a preview');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /stored \$GH_TOKEN/);

  const list = runSync([HIDE, 'list'], env);
  assert.match(list.stdout, /^GH_TOKEN\s/m);

  const exec = runSync([HIDE, 'exec', 'GH_TOKEN', '--', 'echo "value=$GH_TOKEN len=${#GH_TOKEN}"'], env);
  assert.equal(exec.status, 0, exec.stderr);
  assert.equal(exec.stdout.trim(), `value=[hide:GH_TOKEN] len=${fakes.github.length}`);

  const ctx = runSync([HOOK, 'prompt'], env, hookEvent('now push using $GH_TOKEN'));
  const out = JSON.parse(ctx.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /hide exec NAME/);
  assert.match(out.hookSpecificOutput.additionalContext, /\$GH_TOKEN/);
});

test('skipping every match lets the prompt through, and the value is not asked again', async () => {
  const { env, base } = sandbox();
  const prompt = hookEvent(`the sample token ${fakes.github} is from the docs`);
  const hook = runHookAsync(env, prompt);
  await answerFromPane(base, { names: [null] });
  const r = await hook;
  assert.equal(r.status, 0);
  assert.equal(runSync([HIDE, 'list'], env).stdout.trim(), 'No secrets stored.');

  const again = runSync([HOOK, 'prompt'], env, prompt);
  assert.equal(again.status, 0, 'an allowed value must not block or open the pane');
  assert.ok(!readFileSync(join(base, 'config', 'hide', 'allowed.json'), 'utf8').includes(fakes.github), 'only a digest is kept');
});

test('resend targets the pane Claude runs in, and only where that is possible', async () => {
  const { resendTarget } = await import('../plugin/lib/resend.mjs');
  assert.deepEqual(resendTarget({ TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3' }), { via: 'tmux', pane: '%3' });
  assert.deepEqual(resendTarget({ WEZTERM_PANE: '7' }), { via: 'wezterm', pane: '7' });
  assert.equal(resendTarget({ TMUX: 'x', TMUX_PANE: '%3', HIDE_RESEND: '0' }), null);
  assert.equal(resendTarget({ TERM_PROGRAM: 'Apple_Terminal' }), null);
  assert.equal(resendTarget({ WT_SESSION: 'abc' }), null);
});

test('SessionStart announces stored names, never values', () => {
  const { env } = sandbox();
  runSync([HIDE, 'add', 'STRIPE_SECRET_KEY'], env, fakes.stripe);
  const r = runSync([HOOK, 'session'], env, '{}');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\$STRIPE_SECRET_KEY/);
  assert.ok(!ctx.includes(fakes.stripe));
});

test('PreToolUse denies commands that print a keychain value', () => {
  const { env } = sandbox();
  const denied = [
    'security find-generic-password -s hide -a OPENAI_API_KEY -w',
    'security dump-keychain -d login.keychain',
    'secret-tool lookup service hide account X',
    'powershell -c "[Security.Cryptography.ProtectedData]::Unprotect($b, $null, 0)"',
  ];
  for (const command of denied) {
    const r = runSync([HOOK, 'pretool'], env, JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', command);
  }
  const ok = runSync([HOOK, 'pretool'], env, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'hide exec X -- ls' } }));
  assert.equal(ok.stdout, '');
});

test('exec fails clearly for a missing secret and rejects bad names', () => {
  const { env } = sandbox();
  const missing = runSync([HIDE, 'exec', 'NOPE', '--', 'true'], env);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /NOPE is not stored/);
  const bad = runSync([HIDE, 'add', 'bad name'], env, 'x');
  assert.equal(bad.status, 2);
});
