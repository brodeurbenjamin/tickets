/**
 * events-update — weekly refresh of events.json from hyrox.com, plus cleanup.
 *
 * Source (checked 23 Nov 2026):
 *   https://hyrox.com/find-my-race/ lists every race as a WordPress card
 *   (<article class="... type-event ...">) with the race name ("BIOTHERM HYROX
 *   Ottawa"), dates ("21. Apr. 2027 – 25. Apr. 2027", or one date for a one-day
 *   race) and a link to its page (https://hyrox.com/event/<name>/).
 *   Each race page has a "Buy Tickets here" pop-up whose "Athlete Tickets" link
 *   goes to the regional shop: https://ca.hyrox.com/event/<name>. The shop's
 *   ticket list is the same address with /tickets/ instead of /event/.
 *   The WordPress JSON feed has no dates or ticket links, so it isn't used.
 *
 * hyrox.com rate-limits hard (429s after ~10 quick requests, and still at one
 * every 6 s once triggered), so race pages are only fetched for races still
 * missing a shop link: watched races first, then soonest first, a few seconds
 * apart, retrying after a 429. A run stops fetching race pages after
 * PAGE_BUDGET_MS, or as soon as one is still refused after its retries; the
 * rest are picked up by the next run.
 *
 * What it changes:
 *   events.json    adds new races; fills in a missing shop link; updates names
 *                  and dates; drops races that have finished. Fields set by
 *                  hand (id, resale, an existing shop link) are kept.
 *   watchlist.json drops watches for races that have finished. Runs in a few
 *                  minutes, so unlike the watchers it can't overwrite a request
 *                  that arrived mid-run.
 *
 * If the list page can't be read or looks wrong (too few races), nothing is
 * changed and an alert goes to the admin topic.
 */

import { readFileSync, writeFileSync } from 'fs';

const LIST_URL = 'https://hyrox.com/find-my-race/';
const MIN_RACES = 20; // fewer than this means the page layout changed
const PAGE_GAP_MS = Number(process.env.PAGE_GAP_MS ?? 5000);
const RETRY_MS = Number(process.env.RETRY_MS ?? 30000); // first wait after a 429; doubles, then triples
const PAGE_BUDGET_MS = Number(process.env.PAGE_BUDGET_MS ?? 15 * 60000);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const decode = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

// "21. Apr. 2027" -> "2027-04-21"; null if unreadable.
export function isoDate(s) {
  const m = String(s).match(/(\d{1,2})\.?\s*([A-Za-z]{3})[a-z]*\.?\s*(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// "BIOTHERM HYROX Ottawa" -> "Ottawa"; "MAYBELLINE HYROX PARIS GRAND PALAIS" ->
// "Paris Grand Palais"; "HYROX HELSINKI II" -> "Helsinki II"; "Cape Town ||" -> "Cape Town II".
export function cityOf(name) {
  let after = String(name).split(/\bHYROX\b/i).pop().trim() || String(name).trim();
  after = after.replace(/\s\|\|$/, ' II');
  if (after === after.toUpperCase()) after = after.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return after.replace(/\b(i{1,3}|iv|v|vi{1,3}|ix|x)$/i, (m) => m.toUpperCase());
}

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Every adult race card on the list page: { name, city, start, end, page, continent }.
export function parseList(htmlText) {
  const races = [];
  for (const chunk of htmlText.split(/<article\b/).slice(1)) {
    const card = chunk.split('</article>')[0];
    const cls = (card.match(/class="([^"]*)"/) || [])[1] || '';
    if (!/\btype-event\b/.test(cls) || /\btype-youngstars\b/.test(cls)) continue;
    const page = (card.match(/href="(https:\/\/hyrox\.com\/event\/[^"]+)"/) || [])[1];
    const title = card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!page || !title) continue;
    const name = decode(title[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const dates = [...decode(card.replace(/<[^>]+>/g, ' ')).matchAll(/\d{1,2}\.\s*[A-Za-z]{3,4}\.?\s*\d{4}/g)].map((m) => isoDate(m[0]));
    if (!dates[0]) continue;
    races.push({
      name,
      city: cityOf(name),
      start: dates[0],
      end: dates[1] || dates[0],
      page,
      continent: (cls.match(/\bcontinent-([a-z-]+)/) || [])[1] || null,
    });
  }
  return races;
}

// The "Athlete Tickets" link on a race page, as the shop's ticket-list address
// (https://ca.hyrox.com/tickets/<name>); null if the page has none yet.
export function shopFromRacePage(htmlText) {
  const m = htmlText.match(/<a\b[^>]*href="([^"]+)"[^>]*>(?:\s|<[^>]+>)*Athlete Tickets\b/i);
  if (!m) return null;
  const u = new URL(decode(m[1]));
  if (!/\.hyrox\.com$/.test(u.hostname)) return null;
  u.pathname = u.pathname.replace(/^\/events?\//, '/tickets/');
  u.search = '';
  return u.pathname.startsWith('/tickets/') ? u.toString() : null;
}

// Merge freshly read races into the current events. Existing races (matched by
// race page, else by id) keep their id, resale name and shop link; new races
// get id "<city>-<year>" (with the start date added if that's taken).
// Finished races are dropped. Returns { events, added, needShop }.
export function mergeEvents(current, races, today) {
  const byPage = Object.fromEntries(current.filter((e) => e.page).map((e) => [e.page, e]));
  const byId = Object.fromEntries(current.map((e) => [e.id, e]));
  const seen = new Set();
  const events = [];
  const added = [];
  for (const r of races) {
    if (r.end < today) continue;
    const baseId = `${slugify(r.city)}-${r.start.slice(0, 4)}`;
    let old = byPage[r.page] || (!byId[baseId]?.page ? byId[baseId] : null);
    if (old && seen.has(old.id)) old = null;
    let id = old?.id || baseId;
    if (!old && (seen.has(id) || byId[id])) id = `${baseId}-${r.start.slice(5)}`;
    seen.add(id);
    const e = { id, name: r.name, city: old?.city || r.city, start: r.start, end: r.end, continent: r.continent, page: r.page, shop: old?.shop ?? null, resale: old?.resale || r.city.replace(/\s+[IVX]+$/, '') };
    if (!old) added.push(e);
    events.push(e);
  }
  // Races no longer listed but not finished (renamed, moved, or taken down):
  // keep them so watches aren't lost; they drop out after their end date.
  for (const e of current) if (!seen.has(e.id) && e.end >= today) events.push(e);
  events.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { events, added, needShop: events.filter((e) => !e.shop && e.page) };
}

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (res.ok) return res.text();
    if (res.status === 429 && attempt < 4) {
      console.log(`  429 from ${url}, waiting ${(RETRY_MS * attempt) / 1000}s`);
      await new Promise((r) => setTimeout(r, RETRY_MS * attempt));
      continue;
    }
    throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
  }
}

async function push({ title, body, priority = 'default' }) {
  const topic = process.env.NTFY_ADMIN_TOPIC;
  if (!topic) return console.log(`(no NTFY_ADMIN_TOPIC) ${title}: ${body}`);
  const res = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Title: title, Priority: priority }, body });
  if (!res.ok) console.error(`ntfy responded ${res.status}`);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const eventsFile = JSON.parse(readFileSync('events.json', 'utf8'));
  const watchFile = JSON.parse(readFileSync('watchlist.json', 'utf8'));

  let races;
  try {
    races = parseList(await get(LIST_URL));
    if (races.length < MIN_RACES) throw new Error(`only ${races.length} races found on the list page`);
  } catch (err) {
    console.log(`::error title=Race list unreadable::${err.message}`);
    await push({
      title: 'Race list update failed',
      body: `Couldn't read the hyrox.com race list (${err.message}). Kept last week's list. Ask Claude to look at it.`,
      priority: 'high',
    });
    process.exit(1);
  }
  console.log(`${races.length} adult races on the list page`);

  const { events, added, needShop } = mergeEvents(eventsFile.events, races, today);
  const watched = new Set(watchFile.watches.map((w) => w.event));
  needShop.sort((a, b) => watched.has(b.id) - watched.has(a.id) || a.start.localeCompare(b.start));
  const stopAt = Date.now() + PAGE_BUDGET_MS;
  let fetched = 0;
  for (const e of needShop) {
    if (Date.now() > stopAt) break;
    await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    try {
      e.shop = shopFromRacePage(await get(e.page));
      fetched++;
      console.log(`  ${e.id}: ${e.shop || 'no athlete ticket link yet'}`);
    } catch (err) {
      console.log(`  ${e.id}: race page failed (${err.message})`);
      if (err.status === 429) break; // still blocked after retries: try again next run
    }
  }
  const left = needShop.length - fetched;
  if (left) console.log(`${left} race page(s) left for the next run`);

  const live = new Set(events.map((e) => e.id));
  const watches = watchFile.watches.filter((w) => live.has(w.event));
  const dropped = watchFile.watches.length - watches.length;
  const gone = eventsFile.events.filter((e) => !live.has(e.id)).map((e) => e.id);

  writeFileSync('events.json', JSON.stringify({ ...eventsFile, events }, null, 2) + '\n');
  writeFileSync('watchlist.json', JSON.stringify({ ...watchFile, watches }, null, 2) + '\n');
  console.log(`events: ${events.length} (${added.length} new, ${gone.length} finished: ${gone.join(', ') || 'none'})`);
  console.log(`watches: ${watches.length} (${dropped} removed for finished races)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
