# jspratt.dev

Personal homepage, built with Astro as a fully static site and served by an assets-only Cloudflare Worker.

## Develop

Needs the Node version in `.node-version`.

```sh
npm install
npm run dev     # local dev server
npm run check   # astro check (type-check)
npm run build   # static output in dist/
```

## Deploy

Workers Builds deploys `main` to production and gives every other branch a preview URL. `wrangler.jsonc` serves `dist/` with no Worker script. The dashboard setup is in [docs/launch-checklist.md](docs/launch-checklist.md).
