/**
 * © 2026 Hybrid_by_Ben. All rights reserved.
 *
 * Ticket Watch — Google Form side (plan step 5).
 * The request page (site/index.html) submits to this form. On each
 * submission this script checks the request and saves it to watchlist.json
 * in GitHub as "pending", then sends Ben an Approve / Decline notification.
 * The same script, deployed as a web app, handles those two links. One-time
 * codes for the links live in this script's properties, never in the public
 * repo.
 *
 * Script properties (Project Settings > Script properties):
 *   GITHUB_TOKEN      fine-grained token: tickets repo only, Contents = Read and write
 *   GITHUB_REPO       brodeurbenjamin/tickets
 *   NTFY_ADMIN_TOPIC  Ben's private topic: new requests with Approve / Decline
 *   NTFY_TOPIC        community topic: "Now watching ..." when a watch is approved
 *   GITHUB_BRANCH     optional, default "main"
 */
const WATCHLIST_PATH = 'watchlist.json';
const EVENTS_PATH = 'events.json';
const MAX_PENDING = 25;   // a public form can be spammed; approval is the real gate
const MAX_NAMES = 15;     // per watch: joining an existing watch skips approval
const FIELDS = ['Race', 'Division', 'Class', 'Category', 'Name'];

/** Run once from the editor: creates the form and its submit trigger, and prints the page config. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));   // safe to re-run

  const form = FormApp.create('Ticket Watch — request');
  form.setDescription('Used by hybridbyben.com/tickets. Please request from that page instead.');
  form.setConfirmationMessage('Thanks! Your request will show on hybridbyben.com/tickets once it has been checked.');
  form.setCollectEmail(false);
  // Plain text questions, so the request page can submit to this form directly.
  form.addTextItem().setTitle('Race').setRequired(true).setHelpText('Race id from events.json, e.g. ottawa-2027');
  form.addTextItem().setTitle('Division').setRequired(true).setHelpText('Singles, Doubles or Relay');
  form.addTextItem().setTitle('Class').setHelpText('Open or Pro (empty for Relay)');
  form.addTextItem().setTitle('Category').setRequired(true).setHelpText('Men, Women or Mixed');
  form.addTextItem().setTitle('Name').setRequired(true).setHelpText('First name + initial, e.g. Sam K.');

  ScriptApp.newTrigger('onSubmit').forForm(form).onFormSubmit().create();
  PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());
  printConfig();
}

/** Prints the block to paste into site/config.js. */
function printConfig() {
  const form = FormApp.openById(PropertiesService.getScriptProperties().getProperty('FORM_ID'));
  let resp = form.createResponse();
  form.getItems().forEach((it, i) => resp = resp.withItemResponse(it.asTextItem().createResponse('x' + i)));
  const ids = {};
  resp.toPrefilledUrl().replace(/entry\.(\d+)=x(\d)/g, (_, id, i) => { ids[i] = 'entry.' + id; });
  const cfg = {
    FORM_ACTION: form.getPublishedUrl().replace(/\/viewform.*$/, '/formResponse'),
    ENTRY: { race: ids[0], type: ids[1], class: ids[2], gender: ids[3], name: ids[4] },
  };
  Logger.log('Paste this into site/config.js:\n\nwindow.TICKETS_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';');
  const url = ScriptApp.getService().getUrl();
  Logger.log(url ? 'Approve links use: ' + url
                 : 'Not deployed as a web app yet: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).');
}

// ---------- checking a request ----------

const TYPES = ['Singles', 'Doubles', 'Relay'];

// Real HYROX divisions only: Relay has no class; no Mixed Singles or Mixed Pro Doubles.
function division_(type, cls, gender) {
  if (TYPES.indexOf(type) === -1 || ['Men', 'Women', 'Mixed'].indexOf(gender) === -1) return null;
  if (type === 'Relay') return { type, gender };
  if (['Open', 'Pro'].indexOf(cls) === -1) return null;
  if (gender === 'Mixed' && (type === 'Singles' || cls === 'Pro')) return null;
  return { type, class: cls, gender };
}

function watchId_(event, d) {
  return [event, d.type, d.class, d.gender].filter(Boolean).join('-').toLowerCase();
}

function divisionLabel_(d) {
  const who = d.gender === 'Mixed' ? 'Mixed' : d.gender + "'s";
  if (d.type === 'Relay') return who + ' Relay';
  if (d.type === 'Singles') return who + ' ' + d.class;
  return who + ' ' + (d.class === 'Pro' ? 'Pro ' : '') + 'Doubles';
}

// "sam k" -> "Sam K."; letters, spaces and .'- only; null if unusable.
function cleanName_(s) {
  let n = String(s).normalize('NFC').replace(/[^\p{L}\s.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  n = n.replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(\p{L})$/u, '$1.');
  return n.replace(/[^\p{L}]/gu, '').length >= 2 ? n : null;
}

const sameDivision_ = (a, b) => a.type === b.type && a.gender === b.gender && (a.type === 'Relay' || a.class === b.class);
const today_ = () => Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');

function onSubmit(e) {
  const a = {};
  e.response.getItemResponses().forEach(r => { a[r.getItem().getTitle()] = String(r.getResponse()).trim(); });
  const d = division_(a.Division, a.Class, a.Category);
  const name = cleanName_(a.Name || '');
  if (!d || !name || !/^[a-z0-9-]{3,80}$/.test(a.Race || '')) {
    console.warn('Skipped invalid request', a);
    return;
  }
  const race = readFile_(EVENTS_PATH).json.events.filter(ev => ev.id === a.Race)[0];
  if (!race || race.end < today_()) {
    console.warn('Skipped request for unknown or finished race', a.Race);
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let created = null, joined = null;
  try {
    updateWatchlist_(wl => {
      created = joined = null;
      const hit = wl.watches.filter(w => w.event === race.id && sameDivision_(w.division, d))[0];
      if (hit) {   // already watched or waiting: just add the name
        if (hit.requested_by.some(n => n.toLowerCase() === name.toLowerCase())) return null;
        if (hit.requested_by.length >= MAX_NAMES) {
          console.warn('Watch has the most names allowed; skipped', a);
          return null;
        }
        hit.requested_by.push(name);
        joined = hit;
        return `Ticket Watch: ${name} also asked for ${hit.id}`;
      }
      if (wl.watches.filter(w => w.status === 'pending').length >= MAX_PENDING) {
        console.warn('Too many pending requests; skipped', a);
        return null;
      }
      created = { id: watchId_(race.id, d), event: race.id, division: d, status: 'pending', requested_by: [name], created: today_() };
      wl.watches.push(created);
      return `Ticket Watch request: ${created.id} (${name})`;
    });
  } finally {
    lock.releaseLock();
  }
  if (created) askApproval_(created, race);
  if (joined) {   // no approval needed, but Ben should see who joins (and spot abuse)
    notify_('NTFY_ADMIN_TOPIC', {
      title: `${name} joined: ${race.city} ${divisionLabel_(joined.division)}`,
      body: `Now asked for by ${joined.requested_by.join(', ')} (${joined.status}). To remove a name, edit watchlist.json.`,
      priority: 'low',
    });
  }
}

// ---------- approval ----------

function askApproval_(w, race) {
  const url = ScriptApp.getService().getUrl();
  const code = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('approve_' + code, w.id);
  const link = action => `${url}?code=${code}&action=${action}`;
  notify_('NTFY_ADMIN_TOPIC', {
    title: `Watch request: ${race.city} ${divisionLabel_(w.division)}`,
    body: `${w.requested_by.join(', ')} asked to watch ${race.city} ${divisionLabel_(w.division)} (${race.start} to ${race.end}).` +
          (race.shop ? '' : '\nNo official shop link yet; resale only until there is one.'),
    priority: 'default',
    actions: `view, Approve, ${link('approve')}, clear=true; view, Decline, ${link('decline')}, clear=true`,
  });
}

/** The Approve / Decline links in the admin notification land here. */
function doGet(e) {
  const p = PropertiesService.getScriptProperties();
  const code = String((e && e.parameter.code) || ''), action = String((e && e.parameter.action) || '');
  const id = code && p.getProperty('approve_' + code);
  if (!id || ['approve', 'decline'].indexOf(action) === -1) return page_('This link was already used or is not valid.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let w = null;
  try {
    updateWatchlist_(wl => {
      w = wl.watches.filter(x => x.id === id)[0] || null;
      if (!w || w.status !== 'pending') return null;
      if (action === 'approve') {
        w.status = 'active';
        return `Ticket Watch: approved ${id}`;
      }
      wl.watches = wl.watches.filter(x => x.id !== id);
      return `Ticket Watch: declined ${id}`;
    });
    p.deleteProperty('approve_' + code);
  } finally {
    lock.releaseLock();
  }
  if (!w) return page_('That request is no longer in the watch list.');
  if (action === 'decline') return page_(`Declined. ${id} was removed.`);
  const race = readFile_(EVENTS_PATH).json.events.filter(ev => ev.id === w.event)[0] || { city: w.event };
  notify_('NTFY_TOPIC', {
    title: `Now watching: ${race.city} ${divisionLabel_(w.division)}`,
    body: `Asked for by ${w.requested_by.join(', ')}. You'll get an alert here when tickets come up.`,
    priority: 'default',
  });
  return page_(`Approved. ${race.city} ${divisionLabel_(w.division)} is now being watched.`);
}

function page_(text) {
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<div style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px">' +
    '<h2 style="margin:0 0 8px">Ticket Watch</h2><p>' + text.replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') +
    '</p><p><a href="https://hybridbyben.com/tickets/">Open hybridbyben.com/tickets</a></p></div>').setTitle('Ticket Watch');
}

// ntfy headers must be plain ASCII.
function notify_(topicProperty, n) {
  const topic = PropertiesService.getScriptProperties().getProperty(topicProperty);
  if (!topic) return console.warn('No ' + topicProperty + ' set; skipped: ' + n.title);
  const ascii = s => String(s).replace(/[’‘]/g, "'").replace(/[^\x20-\x7E]/g, '?');
  const headers = { Title: ascii(n.title), Priority: n.priority || 'default' };
  if (n.actions) headers.Actions = n.actions;
  const res = UrlFetchApp.fetch('https://ntfy.sh/' + topic, { method: 'post', payload: n.body, headers, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) console.warn('ntfy responded ' + res.getResponseCode());
}

// ---------- GitHub ----------

function gh_() {
  const p = PropertiesService.getScriptProperties();
  return {
    repo: p.getProperty('GITHUB_REPO'),
    branch: p.getProperty('GITHUB_BRANCH') || 'main',
    headers: { Authorization: 'Bearer ' + p.getProperty('GITHUB_TOKEN'), Accept: 'application/vnd.github+json' },
  };
}

function readFile_(path) {
  const g = gh_();
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${g.repo}/contents/${path}?ref=${g.branch}`,
                                { headers: g.headers, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`GitHub read of ${path} failed: ${res.getContentText()}`);
  const file = JSON.parse(res.getContentText());
  const text = Utilities.newBlob(Utilities.base64Decode(file.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { json: JSON.parse(text), sha: file.sha };
}

// Read watchlist.json, let change(wl) edit it and return a commit message (or
// null for no change), write it back. Retries when someone else (a watcher, the
// daily race-list job) committed in between. Same formatting as events-update.js.
function updateWatchlist_(change) {
  const g = gh_();
  const url = `https://api.github.com/repos/${g.repo}/contents/${WATCHLIST_PATH}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const file = readFile_(WATCHLIST_PATH);
    const message = change(file.json);
    if (!message) return false;
    const put = UrlFetchApp.fetch(url, {
      method: 'put', headers: g.headers, muteHttpExceptions: true, contentType: 'application/json',
      payload: JSON.stringify({ message, branch: g.branch, sha: file.sha,
        content: Utilities.base64Encode(JSON.stringify(file.json, null, 2) + '\n', Utilities.Charset.UTF_8) }),
    });
    const code = put.getResponseCode();
    if (code === 200 || code === 201) return true;
    if (code !== 409 && code !== 422) throw new Error('GitHub write failed: ' + put.getContentText());
    Utilities.sleep(1000 * (attempt + 1));
  }
  throw new Error('GitHub write kept conflicting');
}
