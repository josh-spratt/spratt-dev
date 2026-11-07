# Launch checklist

Steps that happen outside the repo, in the Cloudflare dashboard or GitHub. Tick them off as they're done and record any results.

## Workers Builds (#11)

- [ ] Create the Worker by importing `josh-spratt/spratt-dev` in Workers & Pages → Create → Import a repository. GitHub never holds a Cloudflare token.
  - Worker name: `spratt-dev` (must match `name` in `wrangler.jsonc`, or builds fail)
  - Build command: `npm run build`
  - Deploy command: `npx wrangler deploy`
  - Non-production branch deploy command: `npx wrangler versions upload`
  - Production branch: `main`
  - Turn on builds for non-production branches, so every other branch (Dependabot's included) gets a preview URL posted on its PR.
- [ ] Merge to `main` and confirm the Homepage is live at `https://jspratt.dev`.
- [ ] Open a PR from another branch and confirm a public preview URL is posted on it.

## Domain (#11)

- [ ] Attach the apex `jspratt.dev` to the Worker as a Custom Domain.
- [ ] Add a proxied placeholder record for `www` (for example `AAAA www 100::`). Don't attach `www` to the Worker.
- [ ] Add one zone Redirect Rule: requests to `www.jspratt.dev` get a 301 to `https://jspratt.dev` with the path and query kept.
- [ ] Check: `curl -sI 'https://www.jspratt.dev/some/path?q=1'` returns `301` with `location: https://jspratt.dev/some/path?q=1`.
- [ ] The production `workers.dev` URL is turned off in `wrangler.jsonc` (`workers_dev: false`, `preview_urls: true`), so each deploy re-applies it and there's no dashboard toggle to set. After the first deploy, check that `spratt-dev.<account>.workers.dev` doesn't serve the site and that branch preview URLs still work.
  - Result: _not checked yet_ (if previews break, set `workers_dev` to `true` and rely on the canonical link)
