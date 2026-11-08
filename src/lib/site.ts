import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where content lives. Tests point this at fixtures via CONTENT_DIR. */
export const contentDir = resolve(process.env.CONTENT_DIR ?? "content");

/** Production unless BUILD_MODE=preview. Drafts will only show in preview. */
export const buildMode: "production" | "preview" =
  process.env.BUILD_MODE === "preview" ? "preview" : "production";

export interface Site {
  name: string;
  role: string;
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
