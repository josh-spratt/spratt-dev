import { readFileSync } from "node:fs";
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
}

export interface Project {
  title: string;
  description: string;
  url: string;
  /** Optional logo, a path under public/ such as /projects/name.png. */
  image?: string;
  tags?: string[];
}

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
  };
}

function loadProjects(): Project[] {
  const file = "projects.json";
  const raw = readJson(file);
  if (!Array.isArray(raw)) fail(file, "must be a list of projects");
  return raw.map((p: Record<string, any>, i) => {
    const at = `project ${i + 1}`;
    const tags = p.tags;
    if (
      tags !== undefined &&
      (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))
    ) {
      fail(file, `${at}: tags must be a list of strings`);
    }
    return {
      title: requireString(file, `${at}: title`, p.title),
      description: requireString(file, `${at}: description`, p.description),
      url: requireString(file, `${at}: url`, p.url),
      ...(p.image !== undefined
        ? { image: requireString(file, `${at}: image`, p.image) }
        : {}),
      ...(tags ? { tags } : {}),
    };
  });
}

export const site: Site = loadSite();
export const projects: Project[] = loadProjects();

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
