// Values the user marked "skip" (not a secret) in the side pane. Remembered
// for a day by SHA-256, so the same false positive does not open the pane
// again on every prompt, and a resent prompt that still contains it passes.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './store.mjs';

const TTL_MS = 24 * 60 * 60 * 1000;

function file() {
  return join(configDir(), 'allowed.json');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function load() {
  try {
    const all = JSON.parse(readFileSync(file(), 'utf8'));
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now));
  } catch {
    return {}; // first run or unreadable: nothing allowed yet
  }
}

export function isAllowed(value) {
  return digest(value) in load();
}

export function allow(values) {
  if (values.length === 0) return;
  const all = load();
  for (const v of values) all[digest(v)] = Date.now() + TTL_MS;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  renameSync(tmp, file());
}
