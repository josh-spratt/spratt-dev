import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { site, getPosts } from "../../lib/site";

/** Feed readers have no origin of their own, so root-relative URLs must be absolute. */
function absolutize(html: string, origin: URL): string {
  return html.replace(/\b(href|src)="(\/[^"]*)"/g, (_, attr, path) => `${attr}="${new URL(path, origin).href}"`);
}

export async function GET(context: APIContext) {
  const posts = await getPosts();
  return rss({
    title: `Writing · ${site.name}`,
    description: `Posts by ${site.name}`,
    site: context.site!,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.date,
      link: `/writing/${p.id}/`,
      content: absolutize(p.rendered?.html ?? "", context.site!),
    })),
  });
}
