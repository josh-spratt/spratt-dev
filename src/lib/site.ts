import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where content lives. Tests point this at fixtures via CONTENT_DIR. */
export const contentDir = resolve(process.env.CONTENT_DIR ?? "content");

/**
 * Production is a build of `main`; preview is local dev and every other branch.
 * Workers Builds exposes the branch as WORKERS_CI_BRANCH. BUILD_MODE overrides
 * it (tests use that). With neither set, a plain build is production so Drafts
 * can never leak by accident; `astro dev` is preview.
 */
function detectBuildMode(): "production" | "preview" {
  if (process.env.BUILD_MODE === "preview") return "preview";
  if (process.env.BUILD_MODE === "production") return "production";
  const branch = process.env.WORKERS_CI_BRANCH;
  if (branch) return branch === "main" ? "production" : "preview";
  return import.meta.env?.DEV ? "preview" : "production";
}

export const siteUrl = "https://jspratt.dev";

export const buildMode: "production" | "preview" = detectBuildMode();

export interface Site {
  name: string;
  role: string;
  /** Hand-written sentence for the Homepage meta description. */
  description: string;
  bio: string;
  links: { github: string; linkedin: string; email: string };
  /**
   * Cloudflare Web Analytics site token. Not a secret: it ships in the page.
   * When set, production builds include the beacon (zone auto-injection
   * doesn't reach this Worker). Preview builds never do.
   */
  analyticsToken?: string;
}

export interface Project {
  title: string;
  description: string;
  url: string;
  /** Optional logo, a path under public/ such as /projects/name.png. */
  image?: string;
  tags?: string[];
}

/**
 * A Game listed on the Games page and the Homepage. Its page is always on this
 * site at /games/<slug>/, so it has a slug rather than a url.
 */
export interface Game {
  slug: string;
  title: string;
  description: string;
  /** Optional square listing image, a path under public/ such as /game-thumbs/name.webp. */
  image?: string;
  tags?: string[];
}

/** Where a Game's own full-screen page is. */
export const gameHref = (g: Game) => `/games/${g.slug}/`;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(resolve(contentDir, file), "utf8"));
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function requireString(file: string, where: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(file, `${where} must be a non-empty string`);
  }
  return value;
}

function loadSite(): Site {
  const file = "site.json";
  const raw = readJson(file) as Record<string, any>;
  const links = raw.links ?? {};
  return {
    name: requireString(file, "name", raw.name),
    role: requireString(file, "role", raw.role),
    description: requireString(file, "description", raw.description),
    bio: requireString(file, "bio", raw.bio),
    links: {
      github: requireString(file, "links.github", links.github),
      linkedin: requireString(file, "links.linkedin", links.linkedin),
      email: requireString(file, "links.email", links.email),
    },
    ...(raw.analyticsToken !== undefined
      ? { analyticsToken: requireString(file, "analyticsToken", raw.analyticsToken) }
      : {}),
  };
}

/** The title, description, image and tags a Project or Game listing shares. */
function loadListing(file: string, at: string, p: Record<string, any>) {
  const tags = p.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
    fail(file, `${at}: tags must be a list of strings`);
  }
  return {
    title: requireString(file, `${at}: title`, p.title),
    description: requireString(file, `${at}: description`, p.description),
    ...(p.image !== undefined ? { image: requireString(file, `${at}: image`, p.image) } : {}),
    ...(tags ? { tags: tags as string[] } : {}),
  };
}

function loadProjects(): Project[] {
  const file = "projects.json";
  const raw = readJson(file);
  if (!Array.isArray(raw)) fail(file, "must be a list of projects");
  return raw.map((p: Record<string, any>, i) => {
    const at = `project ${i + 1}`;
    const { title, description, ...rest } = loadListing(file, at, p);
    return { title, description, url: requireString(file, `${at}: url`, p.url), ...rest };
  });
}

/** games.json is optional: a site without one has no Games page link or Homepage block. */
function loadGames(): Game[] {
  const file = "games.json";
  if (!existsSync(resolve(contentDir, file))) return [];
  const raw = readJson(file);
  if (!Array.isArray(raw)) fail(file, "must be a list of games");
  return raw.map((g: Record<string, any>, i) => {
    const at = `game ${i + 1}`;
    const slug = requireString(file, `${at}: slug`, g.slug);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(file, `${at}: slug must be lowercase letters, digits and dashes`);
    return { slug, ...loadListing(file, at, g) };
  });
}

export const site: Site = loadSite();
export const projects: Project[] = loadProjects();
export const games: Game[] = loadGames();

/** Posts that should appear in the current build mode, newest first. */
export async function getPosts() {
  const { getCollection } = await import("astro:content");
  const all = await getCollection("posts", (p) => buildMode === "preview" || !p.data.draft);
  return all.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id));
}

/** e.g. "10 Mar 2026". Dates are UTC so builds don't shift by timezone. */
export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
