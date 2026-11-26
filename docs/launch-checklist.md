# Launch checklist

Steps that happen outside the repo, in the Cloudflare dashboard or GitHub. Tick them off as they're done and record any results.

## Workers Builds (#11)

- [x] Create the Worker by importing `josh-spratt/spratt-dev` in Workers & Pages → Create → Import a repository. GitHub never holds a Cloudflare token.
  - Worker name: `spratt-dev` (must match `name` in `wrangler.jsonc`, or builds fail)
  - Build command: `npm run build`
  - Deploy command: `npx wrangler deploy`
  - Non-production branch deploy command: `npx wrangler preview` (the dashboard default; changing it to `npx wrangler versions upload` didn't take effect). It's an open-beta command and needs the `previews` block in `wrangler.jsonc`.
  - Production branch: `main`
  - Turn on builds for non-production branches, so every other branch (Dependabot's included) gets a preview URL posted on its PR.
- [x] Merge to `main` and confirm the Homepage is live at `https://jspratt.dev`.
  - Result (2026-11-07): `https://jspratt.dev/` returns 200 with the built Homepage. A missing path returns 404.
- [x] Open a PR from another branch and confirm a public preview URL is posted on it.
  - Result (2026-11-07, PR #21): Cloudflare posted two preview URLs on the PR. One is per branch (`<branch>-spratt-dev.jaspratt42.workers.dev`) and one is per version (`<id>-spratt-dev.jaspratt42.workers.dev`). Both return 200 with the Homepage.

## Domain (#11)

- [x] Attach the apex `jspratt.dev` to the Worker as a Custom Domain: Worker → **Domains** tab → **Add Domain** → `jspratt.dev`.
- [x] Add a proxied placeholder record for `www`, and don't attach `www` to the Worker.
  - Done as `A www 192.0.2.1`, proxied. That address goes nowhere; Cloudflare answers the request before anything reaches it.
- [x] Add one zone Redirect Rule: requests to `www.jspratt.dev` get a 301 to `https://jspratt.dev` with the path and query kept.
  - Done with the **Redirect from WWW to root** template (Rules → Create rule → Redirect Rule). It matches the wildcard `https://www.*`, redirects to `https://${1}` with a 301, and has **Preserve query string** ticked.
- [x] Check: `curl -sI 'https://www.jspratt.dev/some/path?q=1'` returns `301` with `location: https://jspratt.dev/some/path?q=1`.
  - Result (2026-11-07): passes.
- [x] The production `workers.dev` URL is turned off in `wrangler.jsonc` (`workers_dev: false`, `preview_urls: true`), so each deploy re-applies it and there's no dashboard toggle to set.
  - Result (2026-11-07): `spratt-dev.jaspratt42.workers.dev` returns 404, and branch preview URLs still work with it off.

## Zone settings

- [ ] Optional: turn on **Always Use HTTPS** (SSL/TLS → Edge Certificates).
  - Plain-HTTP requests currently aren't upgraded. `http://www.jspratt.dev/` returns 522, because the redirect rule only matches `https://`. `http://jspratt.dev/` is served without being upgraded.
  - Browsers never send these requests, because `.dev` is HSTS-preloaded. Only tools like `curl` and some bots hit them.
- [x] Turn off the injected bot-detection script, so pages ship no client JS apart from the analytics beacon.
  - Result (2026-11-07): the live HTML has a `/cdn-cgi/challenge-platform/...` script appended. It comes from **Bot Fight Mode** or **JavaScript detections** (Security → Bots).
  - This needs to be gone before the #12 "no page ships a script" test and the Lighthouse byte budget can pass against the live site.
  - Still there on 2026-11-10.
  - Resolved (2026-11-12): accepted. Bot Fight Mode is off, but the script is now `/cdn-cgi/challenge-platform/scripts/jsd/main.js` from **JavaScript detections**, which Cloudflare enables automatically on Free plans and doesn't let you turn off ([docs](https://developers.cloudflare.com/bots/reference/javascript-detections/)). The undocumented API workaround isn't worth relying on. CI, the test suite and Lighthouse run against `dist/`, so they're unaffected. Only the live HTML carries this one extra script.

## Web Analytics

- [x] Paste the site token into `content/site.json` as `analyticsToken`. Find it in Analytics & Logs → Web Analytics → `jspratt.dev` → Manage site → the `token` in the JS snippet. It isn't a secret, because it ships in every page.
  - Why (2026-11-10): zone automatic injection never added the beacon. The live HTML has no `cloudflareinsights` script. Production builds now add the snippet themselves when a token is set, and preview builds never do.
- [x] Check after deploy: `curl -s https://jspratt.dev/ | grep -c cloudflareinsights` returns `1`, and visits appear in the dashboard within a day.
  - Result (2026-11-12): returns `1` after #42 deployed. Dashboard visits not confirmed yet; they should appear by 2026-11-13.
- [x] Turn off automatic injection for the site (Manage site → Advanced Options) so the beacon is never added twice.
  - Done (2026-11-12): RUM switched to **Enable with JS Snippet installation**.

## Cloudflare Access for /stats/ (analytics rebuild, PR 2)

Do these in order. The Worker fails closed (no secrets or no valid Access JWT means `/stats/` is the 404 page), so no order leaves `/stats/` open, but this order means no gap where you can't reach it.

- [ ] Apply the migration before merging: `npx wrangler d1 migrations apply spratt-dev --remote` (adds `owner_visitors`).
- [ ] Zero Trust (one.dash.cloudflare.com) → pick a team name if asked (free plan). Your team domain is `<team>.cloudflareaccess.com` (Settings → Custom Pages shows it).
- [ ] Settings → Authentication: keep **One-time PIN** (email codes), optionally add GitHub as a login method.
- [ ] Access → Applications → Add an application → **Self-hosted**. Name `jspratt.dev stats`; Session duration e.g. 1 month; Application domain `jspratt.dev`, path `stats*` (covers `/stats` and `/stats/…`).
- [ ] Add a policy: Action **Allow**, Include → **Emails** → your own email address. Save.
- [ ] Open the application's **Overview** and copy the **Application Audience (AUD) Tag**.
- [ ] `npx wrangler secret put ACCESS_TEAM_DOMAIN` → `<team>.cloudflareaccess.com`
- [ ] `npx wrangler secret put ACCESS_AUD` → the AUD tag.
- [ ] Merge the PR and wait for the deploy.
- [ ] Open `https://jspratt.dev/stats/` in each browser you use, phone included, and sign in. Check the page footer says "Signed in as …".
- [ ] Check a private window without signing in gets the Access login, and `curl -s -o /dev/null -w '%{http_code}' -H 'cf-access-jwt-assertion: x' https://<branch>-spratt-dev.jaspratt42.workers.dev/stats/` returns 404.
- [ ] The next day, check the cron ran: Worker → Settings → Trigger Events shows `17 3 * * *`, and its log says "stripped Visitor ids …".
