# Cloudflare Pages or Workers static assets?

Ticket: [#2](https://github.com/josh-spratt/spratt-dev/issues/2) (child of map [#1](https://github.com/josh-spratt/spratt-dev/issues/1)).
Researched 2026-11-05 against developers.cloudflare.com. Context: small static personal homepage on `jspratt.dev`, domain registered at Cloudflare, free tier, may grow a blog; Email Routing and Web Analytics also in scope.

## Recommendation

**Use Workers with static assets** (deploy with Wrangler, connect the GitHub repo through Workers Builds, attach `jspratt.dev` as a Worker Custom Domain). Do not start new on Pages.

## Findings

### 1. Cloudflare's current recommendation for new projects

- The Pages docs landing page has a callout: "Are you sure you want to use Pages? Workers supports most Pages use cases and offers a broader feature set. It is Cloudflare's primary platform for building applications. Start new projects with Workers." (page last updated Aug 25, 2026). [Pages docs](https://developers.cloudflare.com/pages/)
- The migration guide says "Unlike Pages, Workers has a distinctly broader set of features available to it." (last updated Oct 12, 2026). [Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)

### 2. Deprecation / migration signals for Pages

- No formal deprecation or end-of-life date was found. The signal is soft but clear: the "Start new projects with Workers" callout, plus an official Pages-to-Workers migration guide. [Pages docs](https://developers.cloudflare.com/pages/), [Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- The migration guide steers Pages users off Pages-specific features. It suggests "considering using another framework if you wish to continue to use file-based routing", and calls Durable Objects on Workers "simpler and recommended". [Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)

### 3. Free-tier limits

| | Workers + static assets | Pages |
|---|---|---|
| Static asset requests | "free and unlimited" ([billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)) | not capped in the limits page ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |
| Worker-script requests | 100,000/day, then error 1027 ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). A pure static site never runs the script. | n/a (Functions billed as Workers) |
| Files per site/version | 20,000 ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) | 20,000 ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |
| Max file size | 25 MiB | 25 MiB |
| Builds | Workers Builds: 3,000 build minutes/month, 1 concurrent, 20 min timeout ([Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)) | 500 builds/month, 1 concurrent, 20 min timeout ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |
| Custom domains | 100 per zone ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) | 100 per project ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |

Caveat: requests that match `run_worker_first` patterns count against the Worker request limit, and over the free limit "these requests will receive a 429". [Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) For a static homepage the two products are effectively equal on limits.

### 4. Git integration and preview deploys

- Workers Builds connects a Worker to GitHub, GitLab, or Cloudflare Artifacts repos. Production-branch builds deploy. "Preview builds run for branches that are not your production branch", and each Preview has a Preview URL. "Supported external providers can also post the URL as a pull request comment." [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- The migration matrix shows Preview URLs supported on both. Branch Deploy Controls are fully supported on Pages and partially (🟡) on Workers. [Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)

### 5. Custom domain on a Cloudflare-registered domain

- On Workers, add a Custom Domain under Settings > Domains & Routes, or with `custom_domain = true` routes in Wrangler. "Cloudflare will create DNS records and issue necessary certificates on your behalf." Apex and `www` are matched exactly, so add both or redirect one to the other. An existing `www` CNAME must be deleted first. [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- Workers "does not support any domain whose nameservers are not managed by Cloudflare". Pages does support those. This doesn't matter here because `jspratt.dev` is a Cloudflare zone. [Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- Worker Custom Domains only add proxied DNS records for the web hostnames, so the MX/TXT records that Email Routing needs on the same zone are unaffected. (Inference: no doc says the two conflict.)

### 6. Redirects and headers

- "_headers and _redirects files are supported natively in Workers with static assets". Both rows are ✅ for Workers and Pages in the matrix. [Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- `_redirects` limits on Workers: 2,000 static plus 100 dynamic redirects, 1,000 characters per line. [Workers redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)

### 7. Web Analytics

- Pages has a one-click toggle on the project's Metrics tab, which injects the snippet on the next deploy. [Web Analytics get started](https://developers.cloudflare.com/web-analytics/get-started/)
- For proxied zones, automatic setup is "enabled by default" once the site is added to Web Analytics. It needs proxied traffic and valid HTML, and is blocked by `Cache-Control: public, no-transform`. [Get started](https://developers.cloudflare.com/web-analytics/get-started/), [FAQ](https://developers.cloudflare.com/web-analytics/faq/)
- The docs don't name Workers explicitly. Because Worker Custom Domains are proxied records on the zone, the zone-level automatic injection should apply (inference). If not, pasting the beacon `<script>` into the HTML template works everywhere. Either way this is a minor difference, not a deciding one.

## Why Workers

1. Cloudflare's docs now say to "Start new projects with Workers" and call it the "primary platform". Pages gets a migration guide, not new investment.
2. Free-tier limits are equivalent or better for this site. Static asset requests are free and unlimited, with 20k files and 25 MiB per file on both products. Workers Builds measures in build minutes (3,000/mo) rather than counting 500 builds.
3. Every feature this site needs is at parity: `_redirects`/`_headers`, Git-connected builds with preview URLs, and custom domains with automatic DNS and certificates.
4. The one real Workers gap, domains not on Cloudflare nameservers, does not apply to a Cloudflare-registered domain.
5. There is room to grow. A later blog or any dynamic bit (forms, an RSS endpoint, SSR) can be added to the same Worker, without later migrating off Pages.
6. Web Analytics is the one place Pages is slightly easier (a one-click toggle). On Workers, use the zone's automatic setup or paste the snippet manually.
