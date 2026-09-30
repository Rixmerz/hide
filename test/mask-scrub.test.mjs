import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskVariants, maskText, maskStream } from '../plugin/lib/mask.mjs';
import { scrubClaudeFiles } from '../plugin/lib/scrub.mjs';
import { fakes } from './fixtures.mjs';

const TOKEN = fakes.github;

async function collect(stream, chunks) {
  const out = [];
  stream.on('data', (d) => out.push(d.toString()));
  const done = new Promise((resolve) => stream.on('end', resolve));
  for (const c of chunks) stream.write(c);
  stream.end();
  await done;
  return out.join('');
}

test('masks the raw value and its base64 form', () => {
  const v = maskVariants({ GITHUB_TOKEN: TOKEN });
  const b64 = Buffer.from(TOKEN).toString('base64');
  assert.equal(maskText(`a ${TOKEN} b ${b64}`, v), 'a [hide:GITHUB_TOKEN] b [hide:GITHUB_TOKEN]');
});

test('masks a secret split across stream chunks', async () => {
  const v = maskVariants({ GITHUB_TOKEN: TOKEN });
  const text = `token=${TOKEN}\nok\n`;
  for (const cut of [1, 7, 10, 20, text.length - 2]) {
    const out = await collect(maskStream(v), [text.slice(0, cut), text.slice(cut)]);
    assert.equal(out, 'token=[hide:GITHUB_TOKEN]\nok\n', `cut at ${cut}`);
  }
});

test('passes output without secrets through unchanged', async () => {
  const v = maskVariants({ GITHUB_TOKEN: TOKEN });
  const out = await collect(maskStream(v), ['hello ', 'world', '\n']);
  assert.equal(out, 'hello world\n');
});

test('scrubs history.jsonl, the transcript and recent paste-cache files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hide-test-'));
  mkdirSync(join(dir, 'paste-cache'));
  const key = fakes.privateKey;
  writeFileSync(join(dir, 'history.jsonl'), JSON.stringify({ display: `use ${key} and ${TOKEN}` }) + '\n');
  writeFileSync(join(dir, 'paste-cache', 'abc.txt'), `pasted ${TOKEN}`);
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, JSON.stringify({ text: TOKEN }) + '\n');

  const touched = scrubClaudeFiles([[key, 'PRIVATE_KEY'], [TOKEN, 'GITHUB_TOKEN']], { claudeDir: dir, transcriptPath: transcript });

  assert.equal(touched.length, 3);
  const history = JSON.parse(readFileSync(join(dir, 'history.jsonl'), 'utf8'));
  assert.equal(history.display, 'use [hide:PRIVATE_KEY] and [hide:GITHUB_TOKEN]');
  assert.equal(readFileSync(join(dir, 'paste-cache', 'abc.txt'), 'utf8'), 'pasted [hide:GITHUB_TOKEN]');
  assert.ok(!readFileSync(transcript, 'utf8').includes(TOKEN));
});

test('masks single lines of a multi-line secret', () => {
  const v = maskVariants({ PRIVATE_KEY: fakes.privateKey });
  const body = fakes.privateKey.split('\n')[1];
  assert.equal(maskText(`line: ${body}`, v), 'line: [hide:PRIVATE_KEY]');
});
