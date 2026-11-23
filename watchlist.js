/**
 * watchlist — what both watchers check, read from two files:
 *
 *   events.json    one entry per race: city, dates, official shop link, and
 *                  the race's event name in the Hybrid Tickets app (`resale`).
 *   watchlist.json one entry per watch: a race plus a division, with who
 *                  asked and a status ("pending" until approved, then "active").
 *
 * Only active watches for races that haven't finished yet are checked. Past
 * watches are ignored here, not deleted: the watchers run for hours from a
 * copy taken at the start, so writing the file back could overwrite a request
 * that arrived in the meantime.
 *
 * Divisions are { type: Singles|Doubles|Relay, class: Open|Pro, gender:
 * Men|Women|Mixed } (Relay has no class). Singles ticket and category names are
 * confirmed from real shop and Hybrid Tickets data; Doubles and Relay names are
 * best guesses, so a wrong guess shows up as a "can't find tickets" alert on
 * the shop and a "possible listing" alert on resale rather than silence.
 */

import { readFileSync } from 'fs';

export function loadFiles(dir = '.') {
  const read = (f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  return { events: read('events.json').events, watches: read('watchlist.json').watches };
}

// Active watches whose race ends today or later (UTC), each joined to its race.
export function activeWatches({ events, watches }, today = new Date().toISOString().slice(0, 10)) {
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  return watches
    .filter((w) => w.status === 'active' && byId[w.event] && byId[w.event].end >= today)
    .map((w) => ({ ...w, race: byId[w.event] }));
}

const isRelay = (d) => d.type === 'Relay';

// "Men's Open", "Women's Pro Doubles", "Mixed Relay"
export function divisionLabel(d) {
  const who = d.gender === 'Mixed' ? 'Mixed' : `${d.gender}'s`;
  const cls = isRelay(d) ? '' : d.type === 'Singles' ? ` ${d.class}` : d.class === 'Pro' ? ' Pro' : '';
  const kind = d.type === 'Singles' ? '' : ` ${d.type}`;
  return `${who}${cls}${kind}`;
}

// Several divisions for one race as one label: "Men's Open/Pro" when only the
// class differs, otherwise "Men's Open, Mixed Doubles".
export function combinedLabel(divisions) {
  const labels = divisions.map(divisionLabel);
  const singles = divisions.every((d) => d.type === 'Singles' && d.gender === divisions[0].gender);
  if (singles && divisions.length > 1) return `${labels[0].split(' ')[0]} ${divisions.map((d) => d.class).join('/')}`;
  return labels.join(', ');
}

// ---------- official shop ----------

// Confirmed ticket names on the ca/usa shop. Charity and adaptive tickets are
// left out on purpose (see shop-watch.js).
const SHOP_NAMES = {
  'Singles/Open/Men': /^HYROX MEN \|/i,
  'Singles/Pro/Men': /^HYROX PRO MEN \|/i,
  'Singles/Open/Women': /^HYROX WOMEN \|/i,
  'Singles/Pro/Women': /^HYROX PRO WOMEN \|/i,
};
const NOT_CHARITY_OR_ADAPTIVE = /^(?!.*(charity|adaptive)).*/i;

// One shop check per watch: { label, shop, drill, name }.
export function shopChecks(active) {
  return active.map((w) => {
    const d = w.division;
    return {
      label: `${w.race.city} ${divisionLabel(d)}`,
      shop: w.race.shop,
      drill: isRelay(d) ? [d.type, d.gender] : [d.type, d.class, d.gender],
      name: SHOP_NAMES[`${d.type}/${d.class}/${d.gender}`] || NOT_CHARITY_OR_ADAPTIVE,
    };
  });
}

// ---------- Hybrid Tickets (resale) ----------

const GENDER_RE = { Men: "men'?s?", Women: "wom[ae]n'?s?", Mixed: 'mixed' };

// Category patterns for one division, in the shape classify() expects.
// Real names seen: "Mens Open", "Mens Pro", "Women Open", "Mixed Doubles",
// "Womens Pro Doubles".
export function resaleCfg(d) {
  const g = GENDER_RE[d.gender];
  // Word boundaries so "men" never matches inside "women".
  const others = Object.keys(GENDER_RE).filter((k) => k !== d.gender).map((k) => `\\b${GENDER_RE[k]}\\b`);
  if (d.type === 'Singles') {
    const c = d.class.toLowerCase();
    return {
      target: new RegExp(`^${g} ${c}$`, 'i'),
      fallback: new RegExp(`\\b${g}\\b.*\\b${c}\\b|\\b${c}\\b.*\\b${g}\\b`, 'i'),
      exclude: new RegExp([...others, 'double', 'relay', 'adaptive', 'team', 'corporate'].join('|'), 'i'),
    };
  }
  const kind = d.type === 'Doubles' ? 'doubles?' : 'relay';
  const pro = d.type === 'Doubles' && d.class === 'Pro';
  return {
    target: new RegExp(`^${g} ${pro ? 'pro ' : ''}${kind}$`, 'i'),
    fallback: new RegExp(`\\b${g}\\b.*\\b${kind}\\b`, 'i'),
    exclude: new RegExp([...others, ...(pro ? [] : ['\\bpro\\b']), 'adaptive', 'corporate'].join('|'), 'i'),
  };
}

// One resale entry per race, keyed by its Hybrid Tickets event name:
// { Ottawa: { label, cfgs: [{ target, fallback, exclude, from, to }] } }.
// `from`/`to` limit race days; null means any day.
export function resaleEvents(active) {
  const out = {};
  for (const w of active) {
    const key = w.race.resale;
    out[key] ??= { label: '', divisions: [], cfgs: [] };
    out[key].divisions.push(w.division);
    out[key].cfgs.push({ ...resaleCfg(w.division), from: w.from ?? null, to: w.to ?? null });
  }
  for (const e of Object.values(out)) e.label = combinedLabel(e.divisions);
  return out;
}
