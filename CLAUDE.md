# Testing

While iterating, run only the test files that cover what you changed, e.g.
`node --test tests/worker.test.ts` (about 4s). Don't chain `npm run check`,
`npm run build` and `npm test` after every edit.

Run the full `npm test` (about 20s) and `npm run check` once, before you
commit.
