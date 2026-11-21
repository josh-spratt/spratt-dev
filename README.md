# jspratt.dev

Personal homepage, built with Astro as a fully static site and served by an assets-only Cloudflare Worker.

## Develop

Needs the Node version in `.node-version`.

```sh
npm install
npm run dev     # local dev server
npm run check   # astro check (type-check)
npm run build   # static output in dist/
npm test        # builds the site and asserts on the output (CONTENT_DIR, BUILD_MODE tweak the build)
npm run check:links  # internal link check on dist/
npm run lhci    # Lighthouse CI on dist/ (build first)
npm run cards   # draw a share card for any Post that lacks one (-- --all redraws every card)
```

Each Post shares its own 1200×630 card from `public/cards/<slug>.png`. Run `npm run cards` after adding a Post and commit the image. The tests fail until you do.

## Games

Twenty Boats is plain JavaScript modules in `public/games/twenty-boats/`, with no build step, served at `/games/twenty-boats/`. It moved here from the private `games-jspratt` repo, whose `games.jspratt.dev` is gone. `public/_headers` serves it with `Cache-Control: no-store`, so a deploy is live on the next load. Its imports also carry a `?v=` cache key (`grep -rn '2026-11-17-v2'`): bump them together on a release, as a second guard. The page preloads every module and data file, reading the list from the game's source. Its game-logic tests are in `tests/twenty-boats/`.

Each Game's page preloads its modules and data with `gamePreloads()` from `src/lib/game-preloads.ts`, which reads them from the Game's own source. The build checks in `tests/games.test.ts` run once per Game: page mounts the game, share card, imports and data built, the 300 KB budget, one `?v=` key, preloads, no site styles, and the event address. A new Game is picked up by adding its folder under `public/games/<name>/` and its page at `src/pages/games/<name>.astro`, then an entry in `games` in that test file for what's particular to it (entry module, extra preloads and files, how many data files, whether it has a `CACHE_BUST` constant, theme colours, event path). The checks fail until every folder in `public/games/` has an entry. Its game-logic tests go in `tests/<name>/`; add that folder to `npm test`.

## Deploy

Workers Builds deploys `main` to production and gives every other branch a preview URL. `wrangler.jsonc` serves `dist/`. A small Worker script (`worker/`) runs only for `/writing/*` and the Games, where it counts and logs Views (and a Game's Plays and Finishes) in a D1 database (`npm run views` shows where they came from, and the private dashboard at `/stats/` charts them): see [docs/database.md](docs/database.md). The dashboard setup is in [docs/launch-checklist.md](docs/launch-checklist.md).

## License

The code is MIT. The writing and images are all rights reserved. See [LICENSE](LICENSE).
