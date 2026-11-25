/**
 * alerts — the latest update for each watched race, shown on the request page.
 *
 *   status/alerts-shop.json    written by shop-watch.js
 *   status/alerts-resale.json  written by roxtickets-watch.js
 *
 * Per watch id: { title, detail, sent, at }. `title` and `detail` are what went
 * to the community alerts topic (never anything from the admin topic), and
 * `at` is when it first went out. `sent: false` marks a change that's shown on
 * the page but wasn't an alert (official-shop tickets selling out again).
 *
 * The watchers repeat an alert every round while tickets stay up. A repeat
 * with the same text changes nothing here, so the file (and the repo) only
 * changes when the message does. One file per watcher, as with status.js, so
 * the two never edit the same file.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { commit } from './status.js';

// When one round sends several alerts for a watch, the page keeps the most
// important: a listing for the division beats "new listing" for the race.
const RANK = { urgent: 3, high: 2, default: 1, low: 0 };

// Collects one round's alerts: round.add(ids, { title, detail, priority, sent }).
export function alertRound() {
  const picked = new Map();
  return {
    picked,
    add(ids, alert) {
      for (const id of ids) {
        const cur = picked.get(id);
        if (!cur || (RANK[alert.priority] ?? 1) > (RANK[cur.priority] ?? 1)) picked.set(id, alert);
      }
    },
  };
}

// The ntfy body minus its "open the app / tap to open" line.
export function detailOf(body) {
  return String(body)
    .split('\n')
    .filter((l) => !/^(On sale now|On Hybrid Tickets now)/.test(l))
    .join('\n')
    .trim();
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Saves this round's alerts. Keeps entries only for watchIds (watches still
// being checked); an entry whose text didn't change keeps its first time.
// Writes and commits only on a change. Returns true if the file changed.
export function saveAlerts(file, round, watchIds, now = new Date().toISOString()) {
  const old = read(file);
  const next = {};
  for (const id of watchIds) {
    const a = round.picked.get(id);
    if (!a) {
      if (old[id]) next[id] = old[id];
      continue;
    }
    const entry = { title: a.title, detail: a.detail ?? '', sent: a.sent !== false };
    const prev = old[id];
    const same = prev && prev.title === entry.title && prev.detail === entry.detail && prev.sent === entry.sent;
    next[id] = { ...entry, at: same ? prev.at : now };
  }
  if (JSON.stringify(next) === JSON.stringify(old)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  if (process.env.COMMIT_STATUS === '1') commit(file);
  return true;
}
