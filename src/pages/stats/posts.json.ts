import { getPosts } from "../../lib/site";

/**
 * The Posts in this build, for the stats dashboard to name and tag what it
 * reads from D1. The Worker reads this straight from the assets and refuses
 * public requests for it, like the rest of /stats/ (worker/index.ts).
 */
export async function GET() {
  const posts = await getPosts();
  const body = posts.map((p) => ({
    slug: p.id,
    title: p.data.title,
    date: p.data.date.toISOString().slice(0, 10),
    tags: p.data.tags ?? [],
  }));
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
