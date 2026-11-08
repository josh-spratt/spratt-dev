import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { contentDir } from "./lib/site";

const posts = defineCollection({
  // The slug is the filename; there is no override.
  loader: glob({
    pattern: "*.md",
    base: `${contentDir}/posts`,
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
  }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
