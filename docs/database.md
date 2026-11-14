# Database

Views and Likes are kept in a Cloudflare D1 database called `spratt-dev`, bound to the Worker as `DB`. The schema lives in `migrations/`.

Only `/writing/*` runs the Worker script (`worker/index.ts`), and every other path is served straight from `dist/`. For a Post page, the Worker:

1. counts a View when the request is a browser navigation (`Sec-Fetch-Mode: navigate`) to `jspratt.dev`
2. writes " · Read N times" into the page's `[data-stats]` placeholder

A Like is a plain form POST to `/writing/<slug>/like`. The Worker:

1. refuses it unless `Origin` matches the site, and 404s for a slug that isn't a Post
2. adds one to `likes` and sets a `liked=1` cookie scoped to that Post's path
3. redirects back to `/writing/<slug>/?liked`, which isn't counted as a new View

A browser that already has the cookie can't like the Post again. Clearing cookies resets that, which is fine for a personal site.

Branch previews read the live counts but never write them. If D1 fails, the static page is served unchanged.

## One-time setup

- [ ] `npx wrangler login`, then `npx wrangler d1 create spratt-dev`.
- [ ] Paste the `database_id` it prints into `wrangler.jsonc`, replacing the all-zero placeholder. The id isn't a secret.
- [ ] `npx wrangler d1 migrations apply spratt-dev --remote`.
- [ ] After the first deploy, open a live Post twice in a browser and check the count with the query below.

## Adding a migration

Add the next numbered `.sql` file to `migrations/`. Run `npx wrangler d1 migrations apply spratt-dev --remote` **before** merging the PR that uses it, because the deploy from `main` expects the new schema to already be there. Every migration should be safe to run while the old code is still live, e.g. adding a column with a default.

## Reading the counts

```sh
npx wrangler d1 execute spratt-dev --remote --command "SELECT * FROM post_stats ORDER BY views DESC"
```

## Local

`npm test` runs the Worker against a fixture build and a throwaway local D1 (`tests/worker.test.ts`). To try it by hand:

```sh
npm run build
npx wrangler d1 migrations apply spratt-dev --local
npx wrangler dev
```

Local requests come from `localhost`, not `jspratt.dev`, so they read counts but don't add Views or Likes.
