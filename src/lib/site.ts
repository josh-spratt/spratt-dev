import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where content lives. Tests point this at fixtures via CONTENT_DIR. */
export const contentDir = resolve(process.env.CONTENT_DIR ?? "content");

/** Production unless BUILD_MODE=preview. Drafts will only show in preview. */
export const buildMode: "production" | "preview" =
  process.env.BUILD_MODE === "preview" ? "preview" : "production";

export const site: { name: string } = JSON.parse(
  readFileSync(resolve(contentDir, "site.json"), "utf8"),
);
