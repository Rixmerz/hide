// Detached follow-up of a blocked prompt, started by the prompt hook right
// before it exits. Input on stdin (never argv):
//   { pairs: [[value, name]], transcriptPath, resend: { target, text } | null }
//
// 1. Sends the clean prompt back into Claude's input once Claude Code has
//    processed the block and is waiting for input again.
// 2. Scrubs Claude Code's local files again: history.jsonl may be appended
//    only after the hook returns.

import { setTimeout as sleep } from 'node:timers/promises';
import { scrubClaudeFiles } from '../lib/scrub.mjs';
import { resend } from '../lib/resend.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));

await sleep(1200);
scrubClaudeFiles(job.pairs, { transcriptPath: job.transcriptPath });
if (job.resend) await resend(job.resend.target, job.resend.text);

for (const delay of [5000, 20000]) {
  await sleep(delay);
  scrubClaudeFiles(job.pairs, { transcriptPath: job.transcriptPath });
}
