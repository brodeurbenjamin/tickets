# Ticket Watch

HYROX ticket alerts for friends and the gym, at https://hybridbyben.com/tickets/.
People request a race and division on the page; Ben approves; two watchers then
check the official shop and Hybrid Tickets resale and alert the community ntfy
topic when tickets come up. Planning notes are kept in Ben's private
planning repo.

| Piece | What it does |
|---|---|
| `events.json` | Upcoming races, refreshed daily from hyrox.com (`events-update.js`) |
| `watchlist.json` | Watches: race + division, `pending` or `active`, who asked |
| `shop-watch.js` | Official shop, every 10 min during a run (`hyrox-watch.yml`) |
| `roxtickets-watch.js` | Hybrid Tickets resale, every 5 min during a run (`roxtickets-watch.yml`) |
| `status/*.json` | What the watchers last saw, the latest alert per watch, and the last daily check-in, for the page (`status.js`, `alerts.js`) |
| `site/` | The request page (`pages.yml`) |
| `google-form/Code.gs` | Takes requests from the page, Approve / Decline links |

## Google Form setup (≈15 min, under the hybridbyben.com Google account)
1. Go to script.google.com → **New project**. Name it "Ticket Watch". Replace `Code.gs` with `google-form/Code.gs`.
2. **Project Settings → Script properties**, add:
   - `GITHUB_TOKEN`: the fine-grained token (this repo only, Contents: Read and write). Expires about 23 Nov 2027.
   - `GITHUB_REPO`: `brodeurbenjamin/tickets`
   - `NTFY_ADMIN_TOPIC`: your private admin topic
   - `NTFY_TOPIC`: `alerts-hybridbyben-k7q2m9x4`
3. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. This hosts the Approve / Decline links. Copy the **Web app URL** (ends in `/exec`) and add it as a fifth script property, `WEBAPP_URL`.
4. Select `setup` and click **Run**; approve the permissions. The log prints a `window.TICKETS_CONFIG = {...}` block.
5. Put that block in `site/config.js` on `main`. The request button turns on when the page republishes. (Lost it? Run `printConfig`.)

**Token expired?** Requests still land in the Form's Responses tab, but stop reaching the watch list. Make a new token and update `GITHUB_TOKEN`.

**Don't edit the Form's questions.** The page relies on them. To change them, update `setup()`, run it again and paste the new config.

**After changing `Code.gs`**, use Deploy → Manage deployments → edit → New version, so the Approve links run the new code.
