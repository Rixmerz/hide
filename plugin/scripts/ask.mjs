// Runs in the side pane the prompt hook opens. It sees only masked previews
// of the secrets, never the values, and answers with one variable name each.
//
// Protocol (all files inside the hook's private mkdtemp dir):
//   request.json  { candidates: [{ preview, kind, suggested }], existing: [names] }
//   answer.json   { names: [name | null] }   null = "not a secret, leave it"
//                 { cancel: true }

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { VAR_NAME, toVarName } from '../lib/detect.mjs';

const dir = process.argv[2];
const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
const existing = new Set(request.existing);

function answer(data) {
  const tmp = join(dir, 'answer.json.tmp');
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, join(dir, 'answer.json'));
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', () => {
  answer({ cancel: true });
  process.exit(130);
});

async function askName(candidate, taken) {
  for (;;) {
    const raw = (await rl.question(`  Variable name [${bold(candidate.suggested)}] (or "skip" if it is not a secret): `)).trim();
    if (raw.toLowerCase() === 'skip') return null;
    const name = raw ? toVarName(raw) : candidate.suggested;
    if (!VAR_NAME.test(name)) {
      console.log('  Use letters, digits and _ only, not starting with a digit.');
      continue;
    }
    if (taken.has(name)) {
      console.log(`  ${name} is already used by another secret in this prompt.`);
      continue;
    }
    if (existing.has(name)) {
      const yes = (await rl.question(`  ${name} already exists. Overwrite it? [y/N]: `)).trim().toLowerCase();
      if (yes !== 'y' && yes !== 'yes') continue;
    }
    return name;
  }
}

console.log(`\n${bold('hide')} — secret detected in your Claude Code prompt`);
console.log(dim('The prompt was held back: Claude has not seen it.'));
console.log(dim('Each secret goes to the OS keychain; Claude only gets its variable name.\n'));

const names = [];
const taken = new Set();
for (const [i, c] of request.candidates.entries()) {
  console.log(`${bold(`[${i + 1}/${request.candidates.length}]`)} ${c.kind}  ${c.preview}`);
  const name = await askName(c, taken);
  if (name) taken.add(name);
  names.push(name);
  console.log();
}
answer({ names });
rl.close();
console.log(names.some(Boolean) ? 'Done. Go back to Claude Code.' : 'Nothing to store. Go back to Claude Code.');
setTimeout(() => process.exit(0), 1500);
