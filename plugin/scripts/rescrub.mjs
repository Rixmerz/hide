// Detached second pass of the history scrub, started by the prompt hook.
// Claude Code may append the blocked prompt to history.jsonl only after the
// hook returns, so the same replacement runs again a little later.
// Input on stdin: { pairs: [[value, name]], transcriptPath }.

import { setTimeout as sleep } from 'node:timers/promises';
import { scrubClaudeFiles } from '../lib/scrub.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { pairs, transcriptPath } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

for (const delay of [1500, 5000, 20000]) {
  await sleep(delay);
  scrubClaudeFiles(pairs, { transcriptPath });
}
