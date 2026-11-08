import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { site, getPosts } from "../../lib/site";

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
      content: p.rendered?.html ?? "",
    })),
  });
}
