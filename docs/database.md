# Database

Views, the View log, Likes, Interest, the Game log and the Leaderboard are kept in a Cloudflare D1 database called `spratt-dev`, bound to the Worker as `DB`. The schema lives in `migrations/`.

Only `/writing/*`, `/stats*`, a Game's page and event address, and the Leaderboard's addresses (`run_worker_first` in `wrangler.jsonc`) run the Worker script (`worker/index.ts`), and every other path is served straight from `dist/`. For a Post page, the Worker:

1. counts a View when the request is a browser navigation (`Sec-Fetch-Mode: navigate`) to `jspratt.dev`, and logs it as a row in `view_log` with the time, the linking site's hostname (from `Referer`) and any `?ref=` tag
2. writes " · Read N times" into the page's `[data-stats]` placeholder

## Your own Views

Visit `https://jspratt.dev/writing/?me` once in each browser you use, phone included. It sets a `me=1` cookie on the whole site that lasts 400 days. That browser's Views, Plays and Finishes are still logged, with `is_me = 1`, but Views don't add to `post_stats`, so the "Read N times" readers see leaves you out. Until 2026-11-17 the cookie was scoped to `/writing/` only, so a browser marked before then needs to visit the address again before its Plays are flagged. Clearing cookies undoes it; visit the address again. Cloudflare Web Analytics doesn't know about the cookie.

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

## Games

Twenty Boats (`/games/twenty-boats/`) and Cactus Boats (`/games/cactus-boats/`) are logged in `game_log`, one row per event, with the same source and owner rules as Posts. Cactus Boats reports a `play` each time you set sail and a `finish` with ending `sunk` and `survived: false` each time you're sunk:

- `view`: the Worker logs a browser navigation to the game's page on `jspratt.dev`, like a Post's View. The page is served as built.
- `play`: the game's `play.js` POSTs `{ "event": "play" }` to `/games/twenty-boats/event` when a run starts (a Draw, or Live this night again).
- `finish`: it POSTs `{ "event": "finish", "ending": "boat-7", "survived": true }` once when that run reaches its Ending.

Each report carries the page's `?ref=` tag and `document.referrer`, which the Worker cleans the same way as a View's (tag rules above, hostname only), so a Play has the same source as the View it came from. The Worker refuses a report from another site, answers 204 and writes nothing off the live hostname, and stores no IP, address or id: a row is the Game, the event, the Ending, the time, the source and `is_me`. Someone could POST fake reports from the page's own origin; for a personal site that's fine.

To log another Game, add its name to `GAMES` in `worker/stats.ts` and its title to `GAME_TITLES` in `worker/dashboard.ts`, its page and `event` address to `run_worker_first`, and an `onEvent` hook like Twenty Boats'.

## Leaderboard

Cactus Boats keeps a global Leaderboard in `scores`, one row per Play that asked to be scored. The game's starter (`public/games/cactus-boats/play.js`) backs its `leaderboard` option with three addresses, so the game itself never knows URLs:

- `POST /games/cactus-boats/start` with `{ ref, referrer }` → `{ "run": 42 }`. The Worker adds a row stamped with `started_at` and the Play's source, cleaned like a Play's. Off the live hostname, or if D1 fails, it answers `{ "run": null }` and writes nothing, and the game shows the board as read-only.
- `POST /games/cactus-boats/score` with `{ run, initials, survivedMs, sinks, score }` → `{ rank, top }`. The Worker fills in that run's row: `submitted_at`, the Initials (exactly three letters, uppercased), the time, the sinks, and its own `scoreOf(survivedMs, sinks)` from the game's `score.js`. It answers 400 for a Score that doesn't match, a run it never handed out, or a malformed body; 403 off the live hostname; 503 if D1 fails.
- `GET /games/cactus-boats/scores` → `{ "top": [{ initials, score, survivedMs, sinks, at }] }`, the top 10. Every host reads the live board, previews too, cached for 10 seconds. If D1 fails it answers an empty board with `"unavailable": true`.

The board is the highest Scores first, the earlier run winning a tie. Only submitted rows are on it; a Play that didn't make the board, or was skipped, leaves a row with only `started_at` and its source.

The two POSTs refuse another Origin (403), anything but POST (405) and a body over 512 bytes (413). Like the Game log, a row stores no IP, address or browser id, and the owner's `me` cookie sets `is_me = 1`, but the owner's Scores still show on the board.

### Plausibility checks

To stop the casual cheats, `score` also refuses a Score with a 400 and writes nothing when:

- the Initials are on a small blocklist of rude three-letter words (`RUDE_INITIALS` in `worker/stats.ts`);
- the Score isn't `scoreOf(survivedMs, sinks)`;
- the run has already been scored: one Score per Play;
- the run started more than 3 hours ago (`RUN_MAX_AGE_HOURS`);
- `survivedMs` is more than the wall-clock time since the run's `started_at`, plus 5 seconds (`CLOCK_ALLOWANCE_MS`) to cover the `start` request's round trip and the second-precision stamp. The clock is D1's, the same one that stamped `started_at`;
- `sinks` is more than the game's spawner could have sent in `survivedMs` (`maxSpawnedBy` in `public/games/cactus-boats/spawn.js`). The Worker imports that same function, so the cap and the game can't drift, and a test checks that they agree.

The run checks are part of the `UPDATE` itself, so two Scores sent at the same moment for one run can't both land. The game shows a refused Score as "not accepted" and carries on.

These checks stop hand-edited requests and replayed runs. They don't stop someone scripting a plausible Score from the page's own origin: start a run, wait, then send a time and sink count that fit. For a personal site that's accepted, as it is for the Game log. If it happens, remove the Score by hand (below).

Read the board, the owner's included:

```sh
npx wrangler d1 execute spratt-dev --remote --command "SELECT id, initials, score, survived_ms, sinks, submitted_at, is_me FROM scores WHERE game = 'cactus-boats' AND submitted_at IS NOT NULL ORDER BY score DESC, id LIMIT 20"
```

Remove a Score by hand (rude Initials, an impossible Score), by its `id` from the query above. The row's start goes too, which is fine:

```sh
npx wrangler d1 execute spratt-dev --remote --command "DELETE FROM scores WHERE id = 42"
```

A browser that read the board just before may show it for up to 10 seconds more.

## One-time setup

- [ ] `npx wrangler login`, then `npx wrangler d1 create spratt-dev`.
- [ ] Paste the `database_id` it prints into `wrangler.jsonc`, replacing the all-zero placeholder. The id isn't a secret.
- [ ] `npx wrangler d1 migrations apply spratt-dev --remote`.
- [ ] After the first deploy, open a live Post twice in a browser and check the count with the query below.

## Adding a migration

Add the next numbered `.sql` file to `migrations/`. Run `npx wrangler d1 migrations apply spratt-dev --remote` **before** merging the PR that uses it, because the deploy from `main` expects the new schema to already be there. Every migration should be safe to run while the old code is still live, e.g. adding a column with a default.

## The dashboard

`https://jspratt.dev/stats/` shows Views per day, per Post, per source and per tag, plus Likes, Interest, the latest Views, and each Game's Views, Plays and Finishes by source and by Ending. The Worker renders it straight from D1 on each load, with no client script. Tags come from each Post's frontmatter via `/stats/posts.json`, which the build writes, so no migration was needed for them.

It's private. Without a `STATS_KEY` secret, `/stats/` (and everything under it) is the ordinary 404 page.

- [ ] Pick a long random key, e.g. `openssl rand -hex 32`, and keep it in your password manager.
- [ ] `npx wrangler secret put STATS_KEY` and paste it.
- [ ] Visit `https://jspratt.dev/stats/?key=<the key>` once in each browser you use. It sets a `stats` cookie on `/stats/` holding a hash of the key, not the key, for 400 days, then redirects to `/stats/`.

Changing the secret signs every browser out. Branch previews don't get the secret, so they show the 404. Locally, put `STATS_KEY=...` in `.dev.vars` (gitignored) before `npx wrangler dev`.

The window is 7, 30 or 90 UTC days (`?days=7`), and `?me` includes your own Views. The all-time numbers come from `post_stats`, which never includes yours.

## Reading the counts

From the terminal, where Views came from, by source, by Post and by day:

```sh
npm run views                 # last 14 days, your own Views left out
npm run views -- --days 60
npm run views -- --with-me    # include your own
```

It ends with the Games: Views, Plays, Finishes and how many lived, by Game and source, then the Endings reached.

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

Local requests come from `localhost`, not `jspratt.dev`, so they read counts and the Leaderboard but don't add Views, Likes, Plays, Finishes or Scores. The game still sends its reports, and the Worker answers each with 204, which is how to see them fire in the browser's network panel.
