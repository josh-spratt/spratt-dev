/**
 * Runs only for /writing/* (see run_worker_first in wrangler.jsonc). Every page
 * is still built statically; for a Post page this counts the View in D1 and
 * writes the count into the HTML, so the page ships no client script.
 */

import { shouldCount, postSlug, statsText } from "./stats.ts";

async function readViews(env: Env, slug: string, count: boolean): Promise<number> {
  // One atomic statement, so concurrent Views can't lose a count.
  const row = count
    ? await env.DB.prepare(
        "INSERT INTO post_stats (slug, views) VALUES (?1, 1) ON CONFLICT (slug) DO UPDATE SET views = views + 1 RETURNING views",
      )
        .bind(slug)
        .first<{ views: number }>()
    : await env.DB.prepare("SELECT views FROM post_stats WHERE slug = ?1").bind(slug).first<{ views: number }>();
  return row?.views ?? 0;
}

export default {
  async fetch(request, env): Promise<Response> {
    const page = await env.ASSETS.fetch(request);
    const slug = postSlug(new URL(request.url).pathname);
    const isHtml = page.headers.get("content-type")?.startsWith("text/html");
    // Only Posts that really exist get counted, so made-up URLs can't create rows.
    if (!slug || page.status !== 200 || !isHtml) return page;

    let views: number;
    try {
      views = await readViews(env, slug, shouldCount(request));
    } catch (err) {
      // D1 down or overloaded: serve the static page; the empty placeholder is hidden.
      console.error("post_stats failed", err);
      return page;
    }
    if (views === 0) return page;

    const res = new HTMLRewriter()
      .on("[data-stats]", {
        element(el) {
          el.setInnerContent(statsText(views));
        },
      })
      .transform(page);
    // The count changes on every View, so this HTML must not be cached.
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    headers.delete("etag");
    return new Response(res.body, { status: res.status, headers });
  },
} satisfies ExportedHandler<Env>;
