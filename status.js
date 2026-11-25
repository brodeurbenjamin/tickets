/**
 * status — the ticket status files the request page reads (plan step 3).
 *
 *   status/shop.json    written by shop-watch.js:      per watch id, each race
 *                       day on the official shop: buyable or not, and price.
 *   status/resale.json  written by roxtickets-watch.js: per watch id, matching
 *                       Hybrid Tickets listings (day and price only; seller
 *                       names are never written anywhere).
 *
 * One file per watcher so the two never edit the same file. A file is only
 * written, and only committed, when its content changes; `since` on each entry
 * is when that watch's status last changed. With COMMIT_STATUS=1 (set in the
 * workflows) a change is committed and pushed straight away, mid-run, so the
 * page doesn't wait for a 3-hour run to end. A failed push is logged and
 * retried with the next change; it never stops the watcher.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname } from 'path';

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// entries: { [watchId]: { ...status } }. Keeps `since` for entries whose status
// didn't change, sets it to now for those that did, and drops watches no
// longer checked. Returns true if the file changed.
export function saveStatus(file, entries, now = new Date().toISOString()) {
  const old = read(file);
  const next = {};
  for (const [id, status] of Object.entries(entries)) {
    const { since, ...prev } = old[id] || {};
    const same = JSON.stringify(prev) === JSON.stringify(status);
    next[id] = { ...status, since: same && since ? since : now };
  }
  if (JSON.stringify(next) === JSON.stringify(old)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  if (process.env.COMMIT_STATUS === '1') commit(file);
  return true;
}

function git(...args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function commit(file) {
  try {
    git('add', file);
    git('-c', 'user.name=ticket-status bot', '-c', 'user.email=actions@github.com', 'commit', '-m', `update ${file}`);
    for (let i = 1; i <= 3; i++) {
      try {
        git('pull', '--rebase', '--autostash', '--quiet'); // the resale watcher's state.json is uncommitted mid-run
        git('push', '--quiet');
        console.log(`  ${file} saved`);
        return;
      } catch (err) {
        console.log(`  ${file}: push attempt ${i} failed (${String(err.stderr || err.message).trim().split('\n')[0]})`);
      }
    }
  } catch (err) {
    console.log(`  ${file}: couldn't commit (${String(err.stderr || err.message).trim().split('\n')[0]})`);
  }
}
