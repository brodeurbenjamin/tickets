/**
 * chain — start the next run of a watcher workflow when this one finishes.
 *
 * GitHub's scheduler often goes hours without firing (see the workflows), so
 * a watcher that just finished a full loop asks GitHub to start its next run
 * straight away. The new run waits in the workflow's queue until this one has
 * ended, so runs never overlap. GitHub lets a workflow's own token start
 * workflow_dispatch runs (unlike most events).
 *
 * The watchers write .chain only after a full loop with active watches. No
 * active watch, a LOOP_MINUTES=0 test or an early crash means no .chain, so
 * no runaway loop of quick runs; the schedule stays as the backup.
 *
 * Usage: node chain.js <workflow file>   (needs GH_TOKEN, GITHUB_REPOSITORY)
 */

import { existsSync, writeFileSync } from 'fs';

export const markFullLoop = () => writeFileSync('.chain', new Date().toISOString() + '\n');

async function main() {
  const workflow = process.argv[2];
  if (!existsSync('.chain')) return console.log('No full loop this run: not starting another (the schedule will).');
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) {
    console.log(`::error title=Couldn't start the next run::GitHub answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Next ${workflow} run requested.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
