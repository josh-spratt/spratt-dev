# Launch checklist

Steps that happen outside the repo, in the Cloudflare dashboard or GitHub. Tick them off as they're done and record any results.

## Workers Builds (#11)

- [x] Create the Worker by importing `josh-spratt/spratt-dev` in Workers & Pages → Create → Import a repository. GitHub never holds a Cloudflare token.
  - Worker name: `spratt-dev` (must match `name` in `wrangler.jsonc`, or builds fail)
  - Build command: `npm run build`
  - Deploy command: `npx wrangler deploy`
  - Non-production branch deploy command: `npx wrangler versions upload`
  - Production branch: `main`
  - Turn on builds for non-production branches, so every other branch (Dependabot's included) gets a preview URL posted on its PR.
- [x] Merge to `main` and confirm the Homepage is live at `https://jspratt.dev`.
  - Result (2026-11-07): `https://jspratt.dev/` returns 200 with the built Homepage. A missing path returns 404.
- [ ] Open a PR from another branch and confirm a public preview URL is posted on it.
  - Result: _not checked yet_. On 2026-11-07 the Worker's Domains tab showed the Preview URL toggle off, even though `wrangler.jsonc` sets `preview_urls: true`. If no preview URL appears, see the `workers.dev` item below.

## Domain (#11)

- [x] Attach the apex `jspratt.dev` to the Worker as a Custom Domain: Worker → **Domains** tab → **Add Domain** → `jspratt.dev`.
- [x] Add a proxied placeholder record for `www`, and don't attach `www` to the Worker.
  - Done as `A www 192.0.2.1`, proxied. That address goes nowhere; Cloudflare answers the request before anything reaches it.
- [x] Add one zone Redirect Rule: requests to `www.jspratt.dev` get a 301 to `https://jspratt.dev` with the path and query kept.
  - Done with the **Redirect from WWW to root** template (Rules → Create rule → Redirect Rule). It matches the wildcard `https://www.*`, redirects to `https://${1}` with a 301, and has **Preserve query string** ticked.
- [x] Check: `curl -sI 'https://www.jspratt.dev/some/path?q=1'` returns `301` with `location: https://jspratt.dev/some/path?q=1`.
  - Result (2026-11-07): passes.
- [x] The production `workers.dev` URL is turned off in `wrangler.jsonc` (`workers_dev: false`, `preview_urls: true`), so each deploy re-applies it and there's no dashboard toggle to set.
  - Result (2026-11-07): `spratt-dev.jaspratt42.workers.dev` returns 404. Whether branch preview URLs still work is checked in the preview item above. If previews break, set `workers_dev` to `true` and rely on the canonical link.

## Zone settings

- [ ] Optional: turn on **Always Use HTTPS** (SSL/TLS → Edge Certificates).
  - Plain-HTTP requests currently aren't upgraded. `http://www.jspratt.dev/` returns 522, because the redirect rule only matches `https://`. `http://jspratt.dev/` is served without being upgraded.
  - Browsers never send these requests, because `.dev` is HSTS-preloaded. Only tools like `curl` and some bots hit them.
- [ ] Turn off the injected bot-detection script, so pages ship no client JS apart from the analytics beacon.
  - Result (2026-11-07): the live HTML has a `/cdn-cgi/challenge-platform/...` script appended. It comes from **Bot Fight Mode** or **JavaScript detections** (Security → Bots).
  - This needs to be gone before the #12 "no page ships a script" test and the Lighthouse byte budget can pass against the live site.
