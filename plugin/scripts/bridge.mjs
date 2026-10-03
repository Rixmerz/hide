// Node side of the in-app flow (hooks/hide.tsx). The hooks module runs with no
// Node, so whatever touches the keychain, the index or Claude Code's files goes
// through here. Values only ever travel over stdin, never argv.
//
//   node bridge.mjs allowed   stdin ["value", ...]           stdout [bool, ...]
//   node bridge.mjs index     (no input)                     stdout { NAME: meta }
//   node bridge.mjs commit    stdin { stored: [{ name, value, kind }],
//                                     skipped: ["value"], redacted: ["value"] }
//                             stdout { stored: ["NAME"] }
//
// commit stores the named secrets, remembers the skipped values as not
// secrets, and scrubs Claude Code's history and paste cache now and again a
// few seconds later (in a detached after.mjs), as the classic hook does.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSecret, readIndex } from '../lib/store.mjs';
import { allow, isAllowed } from '../lib/allow.mjs';
import { scrubClaudeFiles } from '../lib/scrub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

function scrubLater(pairs) {
  const child = spawn(process.execPath, [join(HERE, 'after.mjs')], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(JSON.stringify({ pairs, resend: null }));
  child.unref();
}

function commit({ stored = [], skipped = [], redacted = [] }) {
  for (const { name, value, kind } of stored) saveSecret(name, value, { kind });
  allow(skipped);
  const pairs = [
    ...stored.map(({ name, value }) => [value, name]),
    ...redacted.map((value) => [value, 'REDACTED']),
  ];
  if (pairs.length) {
    scrubClaudeFiles(pairs);
    scrubLater(pairs);
  }
  return { stored: stored.map((s) => s.name) };
}

const MODES = {
  allowed: async () => (await stdin()).map(isAllowed),
  index: async () => readIndex(),
  commit: async () => commit(await stdin()),
};

const mode = MODES[process.argv[2]];
if (!mode) {
  process.stderr.write(`hide bridge: unknown mode "${process.argv[2]}"\n`);
  process.exit(2);
}
try {
  process.stdout.write(JSON.stringify(await mode()));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
