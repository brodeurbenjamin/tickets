/**
 * roxtickets-watch — Hybrid Tickets (roxtickets.app) monitor
 *
 * Unlike the HYROX/vivenu checker, this one hits a real JSON API directly —
 * no browser needed. Captured via mitmproxy on 15 Sep 2026:
 *
 *   GET https://roxtickets.app/api/tickets/getTickets?event=["<EventName>"]&my_tickets=0
 *   Authorization: Bearer <JWT>
 *
 * Each entry in `ticketData` is one individual seller's listing (this is a
 * peer marketplace, not an inventory feed) with category, price, and status.
 *
 * TARGETS come from events.json and watchlist.json (see watchlist.js): one
 * entry per race, keyed by its Hybrid Tickets event name, with category
 * patterns for each watched division. With no active watch, a run sends the
 * daily check-in if due and stops.
 *
 * Category naming seen in real data: "Mens Pro", "Mens Open", "Mixed
 * Doubles", and for women "Women Open" (no s; seen in state.json 13 Oct).
 * Each `target` is the exact-match pattern; `fallback` is a wider
 * net; a fallback hit alerts one priority lower and quotes the real name.
 *
 * DATES — each listing has `day`, e.g. "19-11-2026 THU". Listings outside the
 * trip window never trigger the urgent alert (they still count toward the
 * activity ping). A listing with no readable day is treated as in-window so
 * a format change can't silently hide a real ticket.
 *
 * EVENT NAME — "Paris" is assumed from how Nashville was named ("Nashville").
 * If the app labels it differently, this will quietly report 0 listings
 * forever. Check the heartbeat: if another source shows Paris listings and
 * the heartbeat still says 0, the event name is wrong.
 *
 * TOKEN — the captured JWT has no `exp` claim, so I can't tell you how long
 * it lasts. It may be a long-lived session or it may die whenever the app
 * decides. On a 401 this script says so explicitly rather than reporting
 * "no tickets" — re-run the mitmproxy capture and update the ROX_TOKEN
 * secret if that happens.
 *
 * PRIVACY — each listing includes the seller's real name (`created_by`).
 * That belongs to them, not to this monitor. Deliberately never logged,
 * never pushed in a notification, never written anywhere.
 *
 * STATE — unlike the HYROX checker, this one needs memory: an "activity"
 * alert only means something if we know what the count was last time. State
 * lives in ./state.json, committed back to the repo by the workflow after
 * each run (see roxtickets-watch.yml). Two things use it:
 *   1. Activity alert — fires once when an event's total available count
 *      CHANGES, not on every run while a listing sits there. Stops the
 *      10-minute-forever spam the Womens Open alert deliberately still does.
 *   2. Daily heartbeat — fires once per UTC day regardless of activity, so
 *      you get a positive "still alive" signal without 144 pings a day.
 */

import { loadFiles, activeWatches, resaleEvents } from './watchlist.js';

// What to watch per event, from watchlist.js. Each of an event's `cfgs` is one
// division: `target` = urgent alert; `fallback` (minus `exclude`) = "possible"
// alert; `from`/`to` = race-day window (null = any day). Event names such as
// "Ottawa" are assumed from how Nashville/Dallas were named; check the daily
// heartbeat lists each event with a sensible count once listings exist.
// Past hard-coded targets (Paris, Phoenix) are in git history.
// Loaded below, once push() exists to report an unreadable file.
let WATCH, EVENTS;

// "19-11-2026 THU" -> "2026-11-19"; null if unreadable.
export function listingDate(t) {
  const m = String(t?.day || '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
export function inWindow(t, cfg) {
  const d = listingDate(t);
  if (d === null || !cfg.from) return true;
  return d >= cfg.from && d <= cfg.to;
}
function dayLabel(t) {
  const d = listingDate(t);
  if (!d) return 'day unknown';
  const raw = String(t.day).split(' ')[1] || '';
  const dow = raw ? raw[0].toUpperCase() + raw.slice(1, 3).toLowerCase() : '';
  return `${dow} ${Number(d.slice(8))} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7))]}`.trim();
}
export function classify(available, cfg) {
  const athletes = available.filter((t) => !t.spectator);
  const confirmed = athletes.filter((t) => cfg.target.test(t.category_name));
  const fallback = athletes.filter(
    (t) => !confirmed.includes(t) && cfg.fallback.test(t.category_name) && !cfg.exclude.test(t.category_name)
  );
  return {
    confirmed: confirmed.filter((t) => inWindow(t, cfg)),
    fallback: fallback.filter((t) => inWindow(t, cfg)),
    outOfWindow: [...confirmed, ...fallback].filter((t) => !inWindow(t, cfg)),
  };
}
// classify() for every watched division of one event, merged. A listing that
// is an exact match for one division is never also a "possible" for another.
export function classifyEvent(available, ev) {
  const parts = ev.cfgs.map((cfg) => classify(available, cfg));
  const uniq = (list) => [...new Set(list)];
  const confirmed = uniq(parts.flatMap((p) => p.confirmed));
  return {
    confirmed,
    fallback: uniq(parts.flatMap((p) => p.fallback)).filter((t) => !confirmed.includes(t)),
    outOfWindow: uniq(parts.flatMap((p) => p.outOfWindow)),
  };
}

const STATE_FILE = './state.json';

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const ROX_TOKEN = process.env.ROX_TOKEN;

if (!NTFY_TOPIC) { console.error('NTFY_TOPIC not set.'); process.exit(1); }
if (!ROX_TOKEN) { console.error('ROX_TOKEN not set.'); process.exit(1); }

function asciiHeader(s) {
  return String(s)
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

async function push({ title, body, priority = 'default' }) {
  return fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: asciiHeader(title), Priority: priority },
    body,
  });
}

async function fetchListings(eventName) {
  const url = `https://roxtickets.app/api/tickets/getTickets?event=${encodeURIComponent(JSON.stringify([eventName]))}&my_tickets=0`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${ROX_TOKEN}`,
      'User-Agent': 'roxtickets-watch/1.0 (personal listing monitor)',
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`AUTH FAILED (${res.status}) — token likely expired. Re-capture and update ROX_TOKEN.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for event=${eventName}`);

  const body = await res.json();
  if (!Array.isArray(body.ticketData)) throw new Error('response shape changed — no ticketData array');
  return body.ticketData;
}

async function readState() {
  try {
    const fs = await import('fs/promises');
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { events: {}, lastHeartbeat: null };
  }
}

async function writeState(state) {
  const fs = await import('fs/promises');
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// "Mens Pro" -> "Men's Pro", "Women Open" -> "Women's Open"
function pretty(category) {
  return String(category).replace(/^(wo)?mens?\b/i, (m) => (/^wo/i.test(m) ? "Women's" : "Men's"));
}

function categoryBreakdown(listings) {
  const counts = {};
  for (const t of listings) {
    const k = `${pretty(t.category_name)} (${dayLabel(t)})`;
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, n]) => `${name} x${n}`)
    .join(', ');
}

try {
  WATCH = resaleEvents(activeWatches(loadFiles()));
  EVENTS = Object.keys(WATCH);
} catch (err) {
  console.log(`::error title=watchlist unreadable::${String(err.message).slice(0, 300)}`);
  await push({
    title: 'Ticket watch: watchlist unreadable',
    body: `events.json or watchlist.json can't be read (${err.message}). Nothing is being checked until it's fixed. Ask Claude to look at it.`,
    priority: 'high',
  }).catch(() => {});
  process.exit(1);
}

const state = await readState();
if (!state.events) state.events = {};
// Drop events no longer watched (e.g. old Nashville entry) so the heartbeat
// and state file only reflect current targets.
for (const k of Object.keys(state.events)) if (!EVENTS.includes(k)) delete state.events[k];

const failing = new Set(); // events currently in a failure streak

// One round: check every event, update state, send the daily heartbeat.
// Returns true if every event was checked successfully.
async function checkOnce() {
  let ok = true;
  const today = new Date().toISOString().slice(0, 10); // UTC date, e.g. "2026-09-16"
  const summaryLines = [];

  for (const eventName of EVENTS) {
    try {
      const listings = await fetchListings(eventName);
      const available = listings.filter((t) => t.available_for === 'available');

      const cfg = WATCH[eventName];
      const { confirmed, fallback: fallbackOnly, outOfWindow } = classifyEvent(available, cfg);

      console.log(
        `${eventName}: ${available.length} available listing(s) total, ${confirmed.length} ${cfg.label}${cfg.cfgs.some((c) => c.from) ? ' in trip window' : ''}, ${fallbackOnly.length} fallback match, ${outOfWindow.length} target-division outside window`
      );

      // Full dump for visibility — every listing regardless of category. Log only,
      // never pushed as a notification. created_by (seller's real name) is
      // deliberately omitted — that's someone else's personal data, not needed
      // to see what's for sale.
      if (listings.length > 0) {
        console.log(`  all listings for ${eventName}:`);
        for (const t of listings) {
          console.log(
            `    [${t.ticket_id}] ${t.category_name.padEnd(20)} ${dayLabel(t).padEnd(11)} $${t.total}` +
              ` status=${t.available_for}${t.charity_ticket ? ' charity' : ''}${t.is_discounted ? ' discounted' : ''}`
          );
        }
      } else {
        console.log(`  no listings at all for ${eventName}`);
      }

      if (confirmed.length > 0) {
        const cheapest = confirmed.reduce((a, b) => (a.total < b.total ? a : b));
        await push({
          title: `${eventName} ${new Set(confirmed.map((t) => t.category_name)).size > 1 ? cfg.label : pretty(cheapest.category_name)}: resale listing`,
          body:
            confirmed.map((t) => `${pretty(t.category_name)}, ${dayLabel(t)} - $${t.total}`).join('\n') +
            `\nOn Hybrid Tickets now. Open the app to buy.`,
          priority: 'urgent',
        });
        console.log('notification sent (confirmed match)');
      }

      if (fallbackOnly.length > 0) {
        const cheapest = fallbackOnly.reduce((a, b) => (a.total < b.total ? a : b));
        await push({
          title: `${eventName}: possible ${cfg.label} listing`,
          body:
            `Listed as "${cheapest.category_name}", ${dayLabel(cheapest)} - $${cheapest.total}. ` +
            `Looks like ${cfg.label} but isn't an exact match; check it in Hybrid Tickets.`,
          priority: 'high',
        });
        console.log('notification sent (fallback match — verify category name)');
      }

      // Activity alert — fires only when the total available count for this
      // event CHANGES from last run. Not on every run while it sits non-zero,
      // otherwise this becomes the every-10-minutes spam we're avoiding.
      const prevCount = state.events[eventName]?.available ?? null;
      if (prevCount !== available.length) {
        const breakdown = available.length > 0 ? categoryBreakdown(available) : '(none)';
        const direction = prevCount === null ? 'baseline' : available.length > prevCount ? 'increased' : 'decreased';
        console.log(`  activity: ${prevCount ?? 'n/a'} -> ${available.length} (${direction})`);
        // Skip the very first-ever run (prevCount === null) — that's just
        // establishing the baseline, not a real change worth a ping.
        if (prevCount !== null) {
          await push({
            title: `${eventName} resale: ${available.length > prevCount ? 'new listing' : 'listing gone'}`,
            body:
              `${available.length} listing${available.length === 1 ? '' : 's'} on Hybrid Tickets now (was ${prevCount}).` +
              (available.length > 0 ? `\n${breakdown}` : ''),
            priority: 'default',
          });
          console.log('notification sent (activity change)');
        }
      }

      state.events[eventName] = { available: available.length, categories: categoryBreakdown(available) };
      summaryLines.push(`${eventName}: ${available.length ? `${available.length} listing(s) - ${categoryBreakdown(available)}` : 'no listings'}`);
      failing.delete(`${eventName}:auth`);
      failing.delete(`${eventName}:other`);
    } catch (err) {
      console.error(`${eventName}: FAILED — ${err.message}`);
      console.log(`::error title=roxtickets-watch ${eventName}::${String(err.message).slice(0, 300)}`);
      // Alert once per failure streak, not every round.
      // Separate streaks so an expired token is still reported after an outage.
      const streak = `${eventName}:${/AUTH FAILED/.test(err.message) ? 'auth' : 'other'}`;
      if (!failing.has(streak)) {
        failing.add(streak);
        await push({
          title: `${eventName} resale: check failing`,
          body: /AUTH FAILED/.test(err.message)
            ? `Hybrid Tickets rejected the login token. Ask Claude how to refresh ROX_TOKEN.`
            : `Couldn't check Hybrid Tickets (${err.message}). It will keep retrying.`,
          priority: 'high',
        }).catch(() => {});
      }
      ok = false;
    }
  }

  if (EVENTS.length === 0) summaryLines.push('No active watches right now.');

  // Daily heartbeat — once per UTC calendar day, regardless of activity.
  // This is the "yes, it's still running" signal. A missing heartbeat for a
  // day means something broke — check the Actions tab.
  if (state.lastHeartbeat !== today && ok) {
    await push({
      title: 'Ticket watch: running',
      body: `Daily check-in. Hybrid Tickets is checked every ${INTERVAL_MINUTES} min while a run is active.\n${summaryLines.join('\n')}`,
      priority: 'min',
    });
    state.lastHeartbeat = today;
    console.log('heartbeat sent');
  }

  await writeState(state);
  return ok;
}

// GitHub's scheduler only fires every few hours lately, so one run keeps
// checking every INTERVAL_MINUTES for LOOP_MINUTES (set in the workflow).
// LOOP_MINUTES=0 means check once and exit (handy for a manual test).
// state.json is written every round and committed by the workflow at the end.
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES || 0);
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 5);
// No active watch: one round (for the daily check-in), then stop.
const deadline = EVENTS.length ? Date.now() + LOOP_MINUTES * 60000 : 0;
if (!EVENTS.length) console.log('No active watches for upcoming races - check-in only.');
let lastOk = true;
let round = 0;
do {
  const started = Date.now();
  console.log(`--- round ${++round} at ${new Date().toISOString()}`);
  lastOk = await checkOnce();
  const wait = INTERVAL_MINUTES * 60000 - (Date.now() - started);
  if (Date.now() + Math.max(wait, 0) >= deadline) break;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
} while (Date.now() < deadline);

process.exit(lastOk ? 0 : 1);
