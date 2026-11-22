/**
 * shop-watch — official HYROX shop monitor
 *
 * Works with HYROX's current ticket shop layout (usa/ca.hyrox.com/tickets/<id>,
 * verified 22 Nov 2026). You click Category -> Class -> Gender, and each ticket
 * shows as a button labelled "Add 1 <ticket name> to the cart". If a ticket
 * can't be bought, that button is `disabled` and shows an "Unavailable" badge.
 * An enabled button means it's buyable.
 *
 * To watch another race or division, add an entry to CHECKS. Earlier targets
 * (Paris, Phoenix) live in this repo's git history.
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

const CHECKS = [
  {
    label: "HYROX Ottawa - Men's Open",
    shop: 'https://ca.hyrox.com/tickets/6adf8ccfd5d2d382e327bf65',
    drill: ['Singles', 'Open', 'Men'],
    name: /^HYROX MEN \|/i, // Wed 21 - Sat 24 Apr 2027
  },
  {
    label: "HYROX Ottawa - Men's Pro",
    shop: 'https://ca.hyrox.com/tickets/6adf8ccfd5d2d382e327bf65',
    drill: ['Singles', 'Pro', 'Men'],
    name: /^HYROX PRO MEN \|/i, // Fri 23 Apr 2027 only
  },
];

const NTFY_TOPIC = process.env.NTFY_TOPIC;
if (!NTFY_TOPIC) { console.error('NTFY_TOPIC not set.'); process.exit(1); }

function asciiHeader(s) {
  return String(s)
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

async function push({ title, body, priority = 'default', click }) {
  const headers = { Title: asciiHeader(title), Priority: priority };
  if (click) headers.Click = click;
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: 'POST', headers, body });
  if (!res.ok) console.error(`ntfy responded ${res.status}`);
}

// [{ name, disabled }] for every ticket card on screen.
export async function readTickets(page) {
  return page.$$eval('button[aria-label^="Add 1 "]', (els) =>
    els.map((b) => ({
      name: b.getAttribute('aria-label').replace(/^Add 1 /, '').replace(/ to the cart$/, ''),
      disabled: b.disabled,
    }))
  );
}

export function evaluate(tickets, check) {
  const matches = tickets.filter((t) => check.name.test(t.name));
  const buyable = matches.filter((t) => !t.disabled);
  const tier = matches.length === 0 ? 'structure' : buyable.length > 0 ? 'urgent' : 'none';
  return { matches, buyable, tier };
}

async function runCheck(browser, check) {
  const page = await browser.newPage({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  });
  try {
    await page.goto(check.shop, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await page.getByText('Just a moment', { exact: false }).count()) {
      throw new Error('Cloudflare challenge page - blocked');
    }
    for (const label of check.drill) {
      const opt = page.getByRole('button', { name: label, exact: true }).first();
      await opt.waitFor({ state: 'visible', timeout: 25000 });
      await opt.click();
      await page.waitForTimeout(1500);
    }
    await page.waitForSelector('button[aria-label^="Add 1 "]', { state: 'attached', timeout: 20000 }).catch(() => {});

    const tickets = await readTickets(page);
    const { matches, buyable, tier } = evaluate(tickets, check);
    console.log(check.label);
    for (const t of tickets) {
      const watched = matches.includes(t) ? '' : '  (not watched)';
      console.log(`  ${t.disabled ? 'unavailable' : 'BUYABLE    '}  ${t.name}${watched}`);
    }

    if (tier === 'urgent') {
      await push({
        title: check.label,
        body: `Tickets are live:\n${buyable.map((t) => t.name).join('\n')}`,
        priority: 'urgent',
        click: check.shop,
      });
      console.log('  notification sent (urgent)');
    } else if (tier === 'structure') {
      await push({
        title: `hyrox-watch: page changed (${check.label})`,
        body: `No matching ticket found after clicking ${check.drill.join(' > ')}. The script needs updating.`,
        priority: 'high',
        click: check.shop,
      });
      console.log('  notification sent (structure changed)');
    } else {
      console.log('  all unavailable');
    }
  } finally {
    await page.close();
  }
}

// Each check gets one retry after a short pause (most failures are a slow
// page load or a network blip). A check failing twice doesn't stop the others.
// Returns the labels of checks that failed.
async function checkAll() {
  const browser = await chromium.launch();
  const failed = [];
  try {
    for (const check of CHECKS) {
      try {
        await runCheck(browser, check);
      } catch (first) {
        console.log(`${check.label}: attempt 1 failed: ${first.message} - retrying in 20s`);
        await new Promise((r) => setTimeout(r, 20000));
        try {
          await runCheck(browser, check);
        } catch (err) {
          failed.push({ label: check.label, msg: String(err.message).split('\n')[0].slice(0, 300) });
          console.error(`${check.label}: FAILED: ${err.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  return failed;
}

// GitHub's scheduler only fires every few hours lately, so one run keeps
// checking every INTERVAL_MINUTES for LOOP_MINUTES (set in the workflow).
// LOOP_MINUTES=0 means check once and exit (handy for a manual test).
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES || 0);
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 10);

async function main() {
  const deadline = Date.now() + LOOP_MINUTES * 60000;
  const failing = new Set(); // checks currently in a failure streak (alert once per streak)
  let lastFailed = [];
  let round = 0;
  do {
    const started = Date.now();
    console.log(`--- round ${++round} at ${new Date().toISOString()}`);
    lastFailed = await checkAll();
    for (const f of lastFailed) {
      console.log(`::error title=${f.label} check failed::${f.msg}`);
      if (!failing.has(f.label)) {
        failing.add(f.label);
        await push({ title: `hyrox-watch error (${f.label})`, body: f.msg, priority: 'high' }).catch(() => {});
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
  process.exit(lastFailed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
