/**
 * shop-watch — official HYROX shop monitor
 *
 * Works with HYROX's current ticket shop layout (usa/ca.hyrox.com/tickets/<id>,
 * verified 22 Nov 2026). You click Category -> Class -> Gender, and each ticket
 * shows as a button labelled "Add 1 <ticket name> to the cart". If a ticket
 * can't be bought, that button is `disabled` and shows an "Unavailable" badge.
 * An enabled button means it's buyable.
 *
 * What to check comes from events.json and watchlist.json (see watchlist.js):
 * one check per active watch. Earlier hard-coded targets (Paris, Phoenix) live
 * in this repo's git history.
 *
 * RATE LIMITS — each race's shop is loaded once per round and every watched
 * division read from that page, switching with the Class/Gender breadcrumbs;
 * a different category, or a breadcrumb switch that shows nothing, costs one
 * reload. Different races' shops are SHOP_GAP_MS apart, and a block page or
 * 429 is never retried in the same round. Each division's days go to
 * status/shop.json (see status.js) when they change.
 *
 * CHARITY tickets (e.g. "CHARITY: RACE FOR IMPACT | HYROX MEN | Friday") are
 * deliberately left out: they need a fundraising pledge and are often on sale
 * while the regular tickets are sold out, so including them would alert on
 * every run. Adaptive tickets are left out too.
 *
 * Each run loops (see LOOP_MINUTES below): an urgent alert repeats every
 * round while a ticket stays buyable; an error alert is sent once per failure
 * streak, not every round.
 *
 * Alerts, per check:
 *   URGENT - a matching regular ticket's button is enabled.
 *   HIGH   - no matching ticket on the page at all (layout or naming changed).
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { loadFiles, activeWatches, shopChecks } from './watchlist.js';
import { saveStatus } from './status.js';
import { alertRound, detailOf, saveAlerts } from './alerts.js';
import { markFullLoop } from './chain.js';

// Ticket alerts go to the community topic; problems (a failing check, the shop
// page changing, an unreadable watchlist) go to Ben's admin topic, falling
// back to the community topic if it isn't set, so nothing goes silent.
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_ADMIN_TOPIC = process.env.NTFY_ADMIN_TOPIC || NTFY_TOPIC;
if (!NTFY_TOPIC) { console.error('NTFY_TOPIC not set.'); process.exit(1); }

function asciiHeader(s) {
  return String(s)
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

async function push({ title, body, priority = 'default', click, admin = false }) {
  const headers = { Title: asciiHeader(title), Priority: priority };
  if (click) headers.Click = click;
  const res = await fetch(`https://ntfy.sh/${admin ? NTFY_ADMIN_TOPIC : NTFY_TOPIC}`, { method: 'POST', headers, body });
  if (!res.ok) console.error(`ntfy responded ${res.status}`);
  return res.ok;
}

// This round's community alerts, for the page's "Latest" line (alerts.js).
let alerts = alertRound();

// [{ name, disabled }] for every ticket card on screen.
export async function readTickets(page) {
  return page.$$eval('button[aria-label^="Add 1 "]', (els) =>
    els.map((b) => {
      const text = b.innerText || '';
      const date = text.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/);
      const price = text.match(/(?:CA|US|A|NZ)?\$\s?[\d,]+(?:\.\d{2})?|€\s?[\d.,]+|[\d.,]+\s?€/);
      return {
        name: b.getAttribute('aria-label').replace(/^Add 1 /, '').replace(/ to the cart$/, ''),
        disabled: b.disabled,
        date: date ? date[0] : null, // e.g. "Friday April 23"
        price: price ? price[0] : null, // e.g. "CA$185.00"
      };
    })
  );
}

// "Friday April 23" -> "Fri 23 Apr"; falls back to the day in the ticket name.
export function shortDate(t) {
  const m = String(t.date || '').match(/^(\w{3})\w*\s+(\w{3})\w*\s+(\d{1,2})$/);
  if (m) return `${m[1]} ${m[3]} ${m[2]}`;
  return String(t.name).split('|').pop().trim();
}

// One line per buyable ticket, e.g. "Fri 23 Apr - CA$185.00".
export function ticketLines(tickets) {
  return tickets.map((t) => `${shortDate(t)}${t.price ? ` - ${t.price}` : ''}`).join('\n');
}

export function evaluate(tickets, check) {
  const matches = tickets.filter((t) => check.name.test(t.name));
  const buyable = matches.filter((t) => !t.disabled);
  const tier = matches.length === 0 ? 'structure' : buyable.length > 0 ? 'urgent' : 'none';
  return { matches, buyable, tier };
}

const SHOP_GAP_MS = Number(process.env.SHOP_GAP_MS ?? 5000); // pause between different races' shops
const LEVELS = { 3: ['Category', 'Class', 'Gender'], 2: ['Category', 'Gender'] }; // breadcrumb names by drill depth

async function openShop(page, shop) {
  console.log(`loading ${shop}`);
  const res = await page.goto(shop, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (res && res.status() === 429) throw Object.assign(new Error('shop answered 429 (too many requests)'), { blocked: true });
  if (await page.getByText('Just a moment', { exact: false }).count()) {
    throw Object.assign(new Error('Cloudflare challenge page - blocked'), { blocked: true });
  }
}

// Move from the division on screen (`from`, a drill path, or null right after
// loading) to `to`. Same category: click the breadcrumb of the first choice
// that differs ("Class Open", "Gender Men") to go back to that step, then pick
// the rest. Different category: reload, since the category step doesn't come
// back reliably from its breadcrumb (checked 23 Nov 2026).
async function pick(page, labels, timeout) {
  for (const label of labels) {
    const opt = page.getByRole('button', { name: label, exact: true }).first();
    await opt.waitFor({ state: 'visible', timeout });
    await opt.click();
    await page.waitForTimeout(1500);
  }
}

// If the breadcrumb route doesn't show the expected choice (seen going from
// Women's Open to Men's Pro), reload and pick the whole path instead.
// Returns true if it got there by breadcrumbs, false after a fresh load.
async function goTo(page, shop, from, to) {
  let done = false;
  if (Array.isArray(from) && from[0] === to[0] && from.length === to.length) {
    const k = to.findIndex((label, i) => label !== from[i]);
    if (k === -1) return true; // already showing this division
    try {
      await pick(page, [`${LEVELS[from.length][k]} ${from[k]}`, ...to.slice(k)], 8000);
      done = true;
    } catch {
      console.log(`  breadcrumb route to ${to.join(' > ')} didn't work, reloading`);
    }
  }
  if (!done) {
    if (from) await openShop(page, shop);
    await pick(page, to, 25000);
  }
  await page.waitForSelector('button[aria-label^="Add 1 "]', { state: 'attached', timeout: 20000 }).catch(() => {});
  return done;
}

// The list redraws after each switch; read it once this division's tickets
// are on screen, or after 10 s, when "none" may be the real answer.
async function readFor(page, check) {
  let tickets = await readTickets(page);
  for (let waited = 0; waited < 10000 && !tickets.some((t) => check.name.test(t.name)); waited += 1000) {
    await page.waitForTimeout(1000);
    tickets = await readTickets(page);
  }
  return tickets;
}

// Check every watched division on one race's shop from a single page load
// (plus one reload per extra category). Alerts as each division is read.
// Returns { status: { [watchId]: { days } }, failed: [{ label, msg, blocked }] }.
async function runShop(browser, shop, checks) {
  const page = await browser.newPage({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  });
  const status = {};
  const failed = [];
  try {
    await openShop(page, shop);
    let at = null;
    for (const check of checks) {
      let tickets;
      try {
        const viaCrumbs = await goTo(page, shop, at, check.drill);
        at = check.drill;
        tickets = await readFor(page, check);
        // Nothing after a breadcrumb switch (seen for Men's -> Women's Doubles):
        // never trust that; reload and pick the division from scratch.
        if (viaCrumbs && !tickets.some((t) => check.name.test(t.name))) {
          console.log(`  nothing shown for ${check.drill.join(' > ')} after switching, reloading`);
          await goTo(page, shop, 'unknown', check.drill);
          tickets = await readFor(page, check);
        }
      } catch (err) {
        if (err.blocked) throw err;
        failed.push({ label: check.label, msg: String(err.message).split('\n')[0].slice(0, 300) });
        console.error(`${check.label}: FAILED: ${err.message}`);
        at = 'unknown'; // page state unknown: the next division starts from a fresh load
        continue;
      }

      const { matches, buyable, tier } = evaluate(tickets, check);
      console.log(check.label);
      for (const t of tickets) {
        const watched = matches.includes(t) ? '' : '  (not watched)';
        console.log(`  ${t.disabled ? 'unavailable' : 'BUYABLE    '}  ${t.name}${watched}`);
      }
      status[check.id] = { days: matches.map((t) => ({ day: shortDate(t), buyable: !t.disabled, price: t.price })) };

      if (tier === 'urgent') {
        const alert = {
          title: `${check.label}: tickets available`,
          body: `${ticketLines(buyable)}\nOn sale now on the official shop. Tap to open it.`,
          priority: 'urgent',
          click: check.shop,
        };
        if (await push(alert)) alerts.add([check.id], { ...alert, detail: detailOf(alert.body) });
        console.log('  notification sent (urgent)');
      } else if (tier === 'structure') {
        await push({
          title: `${check.label}: can't find tickets`,
          body: `The shop page has changed, so this check can't see the tickets any more. Ask Claude to update it.`,
          priority: 'high',
          admin: true,
          click: check.shop,
        });
        console.log('  notification sent (structure changed)');
      } else {
        console.log('  all unavailable');
      }
    }
  } catch (err) {
    // Page load failed or the shop blocked us: every unchecked division fails.
    const msg = String(err.message).split('\n')[0].slice(0, 300);
    for (const c of checks) if (!status[c.id] && !failed.some((f) => f.label === c.label)) failed.push({ label: c.label, msg, blocked: !!err.blocked });
    console.error(`${shop}: FAILED: ${err.message}`);
  } finally {
    await page.close();
  }
  return { status, failed };
}

// Group checks by shop (one race = one shop page), same-category divisions
// next to each other so they share a page load.
export function byShop(checks) {
  const groups = new Map();
  for (const c of checks) groups.set(c.shop, [...(groups.get(c.shop) || []), c]);
  for (const list of groups.values()) list.sort((a, b) => a.drill.join('>').localeCompare(b.drill.join('>')));
  return groups;
}

// One round over every shop, a pause between shops. A shop with failed
// divisions gets one retry after a short pause (most failures are a slow page
// load or a network blip), but never when the shop blocked us: that waits for
// the next round. Returns { status, failed }.
async function checkAll(checks) {
  const browser = await chromium.launch();
  const status = {};
  const failed = [];
  try {
    let first = true;
    for (const [shop, group] of byShop(checks)) {
      if (!first) await new Promise((r) => setTimeout(r, SHOP_GAP_MS));
      first = false;
      let r = await runShop(browser, shop, group);
      if (r.failed.length && !r.failed.some((f) => f.blocked)) {
        const again = group.filter((c) => r.failed.some((f) => f.label === c.label));
        console.log(`${shop}: ${again.length} division(s) failed - retrying in 20s`);
        await new Promise((res) => setTimeout(res, 20000));
        const r2 = await runShop(browser, shop, again);
        r = { status: { ...r.status, ...r2.status }, failed: r2.failed };
      }
      Object.assign(status, r.status);
      failed.push(...r.failed);
    }
  } finally {
    await browser.close();
  }
  return { status, failed };
}

// GitHub's scheduler only fires every few hours lately, so one run keeps
// checking every INTERVAL_MINUTES for LOOP_MINUTES (set in the workflow).
// LOOP_MINUTES=0 means check once and exit (handy for a manual test).
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES || 0);
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 10);

async function main() {
  let checks;
  try {
    checks = shopChecks(activeWatches(loadFiles()));
  } catch (err) {
    console.log(`::error title=watchlist unreadable::${String(err.message).slice(0, 300)}`);
    await push({
      title: 'Ticket watch: watchlist unreadable',
      body: `events.json or watchlist.json can't be read (${err.message}). Nothing is being checked until it's fixed. Ask Claude to look at it.`,
      priority: 'high',
      admin: true,
    }).catch(() => {});
    process.exit(1);
  }
  if (checks.length === 0) {
    console.log('No active watches for upcoming races - nothing to check.');
    process.exit(0);
  }
  console.log(`Watching: ${checks.map((c) => c.label).join(', ')}`);
  const deadline = Date.now() + LOOP_MINUTES * 60000;
  const failing = new Set(); // checks currently in a failure streak (alert once per streak)
  let lastFailed = [];
  let round = 0;
  do {
    const started = Date.now();
    console.log(`--- round ${++round} at ${new Date().toISOString()}`);
    const { status, failed } = await checkAll(checks);
    lastFailed = failed;
    // Only watches checked this round are written; a failed one keeps its last
    // known status rather than disappearing from the page.
    const previous = (() => { try { return JSON.parse(readFileSync('status/shop.json', 'utf8')); } catch { return {}; } })();
    const keep = Object.fromEntries(checks.filter((c) => !status[c.id] && previous[c.id]).map((c) => {
      const { since, ...rest } = previous[c.id];
      return [c.id, rest];
    }));
    if (saveStatus('status/shop.json', { ...keep, ...status })) console.log('status/shop.json updated');
    // Tickets that were on sale and now aren't: shown on the page, not alerted.
    for (const c of checks) {
      const was = previous[c.id]?.days?.some((d) => d.buyable);
      const now = status[c.id]?.days?.some((d) => d.buyable);
      if (was && status[c.id] && !now && !alerts.picked.has(c.id)) {
        alerts.add([c.id], { title: `${c.label}: sold out again`, detail: '', priority: 'low', sent: false });
      }
    }
    if (saveAlerts('status/alerts-shop.json', alerts, checks.map((c) => c.id))) console.log('status/alerts-shop.json updated');
    alerts = alertRound();
    for (const f of lastFailed) {
      console.log(`::error title=${f.label} check failed::${f.msg}`);
      if (!failing.has(f.label)) {
        failing.add(f.label);
        await push({
          title: `${f.label}: check failing`,
          body: `Couldn't check the official shop (${f.msg}). It will keep retrying; you'll only hear about it again if it starts failing after recovering.`,
          priority: 'high',
          admin: true,
        }).catch(() => {});
      }
    }
    for (const label of [...failing]) {
      if (!lastFailed.some((f) => f.label === label)) {
        failing.delete(label);
        console.log(`${label}: recovered`);
      }
    }
    const wait = INTERVAL_MINUTES * 60000 - (Date.now() - started);
    if (Date.now() + Math.max(wait, 0) >= deadline) break;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  } while (Date.now() < deadline);
  if (LOOP_MINUTES > 0) markFullLoop(); // the workflow starts the next run (chain.js)
  process.exit(lastFailed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
