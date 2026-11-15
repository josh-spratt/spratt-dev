# Database

Views, the View log, Likes and Interest are kept in a Cloudflare D1 database called `spratt-dev`, bound to the Worker as `DB`. The schema lives in `migrations/`.

Only `/writing/*` runs the Worker script (`worker/index.ts`), and every other path is served straight from `dist/`. For a Post page, the Worker:

1. counts a View when the request is a browser navigation (`Sec-Fetch-Mode: navigate`) to `jspratt.dev`, and logs it as a row in `view_log` with the time, the linking site's hostname (from `Referer`) and any `?ref=` tag
2. writes " · Read N times" into the page's `[data-stats]` placeholder

## Your own Views

Visit `https://jspratt.dev/writing/?me` once in each browser you use, phone included. It sets a `me=1` cookie on `/writing/` that lasts 400 days. That browser's Views are still logged, with `is_me = 1`, but don't add to `post_stats`, so the "Read N times" readers see leaves you out. Clearing cookies undoes it; visit the address again. Cloudflare Web Analytics doesn't know about the cookie.

## Tagging shared links

Add `?ref=<where>` when sharing a Post, e.g. `https://jspratt.dev/writing/the-graveyard/?ref=bluesky`. Many apps (Slack, Discord, most phone apps) send no referrer, so without a tag those Views show as `direct`. Tags are lowercased and cut to 40 characters of `a-z 0-9 . _ -`.

## Likes and Interest

A Like is a plain form POST to `/writing/<slug>/like`. The Worker:

1. refuses it unless `Origin` matches the site, and 404s for a slug that isn't a Post
2. adds one to `likes` and sets a `liked=1` cookie scoped to that Post's path
3. redirects back to `/writing/<slug>/?liked`, which isn't counted as a new View

A browser that already has the cookie can't like the Post again. Clearing cookies resets that, which is fine for a personal site.

Interest works the same way at `/writing/<slug>/interest`, with two differences. Each answer is a row in `interest` (slug and time), not a counter, and the `interested=1` cookie is scoped to `/writing/`, so a browser answers once across all Posts. A browser with the cookie sees a thank-you in place of the question on every Post. Nobody else sees a count.

Branch previews read the live counts but never write them. If D1 fails, the static page is served unchanged.

## One-time setup

- [ ] `npx wrangler login`, then `npx wrangler d1 create spratt-dev`.
- [ ] Paste the `database_id` it prints into `wrangler.jsonc`, replacing the all-zero placeholder. The id isn't a secret.
- [ ] `npx wrangler d1 migrations apply spratt-dev --remote`.
- [ ] After the first deploy, open a live Post twice in a browser and check the count with the query below.

## Adding a migration

Add the next numbered `.sql` file to `migrations/`. Run `npx wrangler d1 migrations apply spratt-dev --remote` **before** merging the PR that uses it, because the deploy from `main` expects the new schema to already be there. Every migration should be safe to run while the old code is still live, e.g. adding a column with a default.

## Reading the counts

Where Views came from, by source, by Post and by day:

```sh
npm run views                 # last 14 days, your own Views left out
npm run views -- --days 60
npm run views -- --with-me    # include your own
```

A View's source is its `?ref=` tag if it has one, else the linking site, else `direct`. Views before `view_log` existed (2026-11-15) are only in the `post_stats` totals.

The totals:

```sh
npx wrangler d1 execute spratt-dev --remote --command "SELECT * FROM post_stats ORDER BY views DESC"
```

How many browsers would subscribe, and which Posts prompted them:

```sh
npx wrangler d1 execute spratt-dev --remote --command "SELECT slug, COUNT(*) AS answers, MAX(created_at) AS latest FROM interest GROUP BY slug ORDER BY answers DESC"
npx wrangler d1 execute spratt-dev --remote --command "SELECT COUNT(*) AS total FROM interest"
```

## Local

`npm test` runs the Worker against a fixture build and a throwaway local D1 (`tests/worker.test.ts`). To try it by hand:

```sh
npm run build
npx wrangler d1 migrations apply spratt-dev --local
npx wrangler dev
```

Local requests come from `localhost`, not `jspratt.dev`, so they read counts but don't add Views or Likes.
