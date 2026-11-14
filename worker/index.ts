/**
 * Runs only for /writing/* (see run_worker_first in wrangler.jsonc). Every page
 * is still built statically. For a Post page this counts the View in D1 and
 * writes the View and Like counts into the HTML; a Like is a plain form POST.
 * So the page ships no client script.
 */

import {
  hasLiked,
  isLive,
  isSameOrigin,
  likeLabel,
  likeSlug,
  likedCookie,
  postSlug,
  shouldCount,
  statsText,
} from "./stats.ts";

interface Stats {
  views: number;
  likes: number;
}

// Each change is one atomic statement, so concurrent Views or Likes can't lose a count.
const COUNT_VIEW =
  "INSERT INTO post_stats (slug, views) VALUES (?1, 1) ON CONFLICT (slug) DO UPDATE SET views = views + 1 RETURNING views, likes";
const COUNT_LIKE =
  "INSERT INTO post_stats (slug, likes) VALUES (?1, 1) ON CONFLICT (slug) DO UPDATE SET likes = likes + 1";
const READ = "SELECT views, likes FROM post_stats WHERE slug = ?1";

async function readStats(env: Env, slug: string, count: boolean): Promise<Stats> {
  const row = await env.DB.prepare(count ? COUNT_VIEW : READ).bind(slug).first<Stats>();
  return row ?? { views: 0, likes: 0 };
}

/** Only Posts that really exist get rows, so made-up URLs can't create them. */
async function postExists(env: Env, request: Request, slug: string): Promise<boolean> {
  const page = await env.ASSETS.fetch(new URL(`/writing/${slug}/`, request.url));
  return page.status === 200;
}

async function like(request: Request, env: Env, slug: string): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  if (!(await postExists(env, request, slug))) return new Response("Not Found", { status: 404 });

  const headers = new Headers({ location: `/writing/${slug}/?liked` });
  // Previews never write, and a browser that already liked this Post can't again.
  if (isLive(request) && !hasLiked(request)) {
    try {
      await env.DB.prepare(COUNT_LIKE).bind(slug).run();
      headers.set("set-cookie", likedCookie(slug));
    } catch (err) {
      // No cookie, so the reader can try again once D1 is back.
      console.error("like failed", err);
    }
  }
  return new Response(null, { status: 303, headers });
}

async function post(request: Request, env: Env, slug: string, page: Response): Promise<Response> {
  let stats: Stats;
  try {
    stats = await readStats(env, slug, shouldCount(request));
  } catch (err) {
    // D1 down or overloaded: serve the static page; the empty placeholder is hidden.
    console.error("post_stats failed", err);
    return page;
  }
  const liked = hasLiked(request);

  const res = new HTMLRewriter()
    .on("[data-stats]", {
      element(el) {
        if (stats.views > 0) el.setInnerContent(statsText(stats.views));
      },
    })
    .on("[data-like-label]", {
      element(el) {
        el.setInnerContent(likeLabel(stats.likes, liked));
      },
    })
    .transform(page);
  // The counts change on every View, so this HTML must not be cached.
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  headers.delete("etag");
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const liking = likeSlug(pathname);
    if (liking) return like(request, env, liking);

    const page = await env.ASSETS.fetch(request);
    const slug = postSlug(pathname);
    const isHtml = page.headers.get("content-type")?.startsWith("text/html");
    if (!slug || page.status !== 200 || !isHtml) return page;
    return post(request, env, slug, page);
  },
} satisfies ExportedHandler<Env>;
