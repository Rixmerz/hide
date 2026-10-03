// scripts/bridge.mjs: the Node side of the in-app flow (plugin/hooks/hide.tsx),
// with the test-only file backend and a throwaway config and Claude dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakes } from './fixtures.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts', 'bridge.mjs');

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'hide-bridge-'));
  for (const d of ['config', 'claude']) mkdirSync(join(base, d));
  const env = {
    ...process.env,
    HIDE_BACKEND: 'plaintext-file-for-tests',
    XDG_CONFIG_HOME: join(base, 'config'),
    LOCALAPPDATA: join(base, 'config'),
    CLAUDE_CONFIG_DIR: join(base, 'claude'),
  };
  const run = (mode, input) => {
    const r = spawnSync(process.execPath, [BRIDGE, mode], {
      env,
      input: input === undefined ? '' : JSON.stringify(input),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { base, run };
}

test('commit stores named secrets, allows skipped ones and scrubs history', () => {
  const { base, run } = sandbox();
  const history = join(base, 'claude', 'history.jsonl');
  writeFileSync(history, JSON.stringify({ display: `use ${fakes.openaiProject} and ${fakes.github}` }) + '\n');

  assert.deepEqual(run('allowed', [fakes.openaiProject, fakes.github]), [false, false]);
  const out = run('commit', {
    stored: [{ name: 'OPENAI_API_KEY', value: fakes.openaiProject, kind: 'openai' }],
    skipped: [fakes.github],
  });

  assert.deepEqual(out, { stored: ['OPENAI_API_KEY'] });
  assert.deepEqual(Object.keys(run('index')), ['OPENAI_API_KEY']);
  assert.deepEqual(run('allowed', [fakes.openaiProject, fakes.github]), [false, true]);
  const scrubbed = readFileSync(history, 'utf8');
  assert.ok(!scrubbed.includes(fakes.openaiProject));
  assert.ok(scrubbed.includes('[hide:OPENAI_API_KEY]'));
});

test('commit with redacted values stores nothing and scrubs them', () => {
  const { base, run } = sandbox();
  const history = join(base, 'claude', 'history.jsonl');
  writeFileSync(history, JSON.stringify({ display: fakes.openaiProject }) + '\n');

  assert.deepEqual(run('commit', { redacted: [fakes.openaiProject] }), { stored: [] });
  assert.deepEqual(run('index'), {});
  assert.ok(readFileSync(history, 'utf8').includes('[hide:REDACTED]'));
});

test('a value never shows up in the bridge output', () => {
  const { run } = sandbox();
  const out = JSON.stringify(run('commit', { stored: [{ name: 'K', value: fakes.openaiProject, kind: 'openai' }] }));
  assert.ok(!out.includes(fakes.openaiProject));
});
