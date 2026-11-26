import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "node-html-parser";

export interface BuildOptions {
  /** Content location; defaults to the real content. */
  contentDir?: string;
  /** Force production or preview mode. */
  mode?: "production" | "preview";
}

export interface Site {
  outDir: string;
  /** Read a built file as text, e.g. `read("index.html")`. */
  read(path: string): string;
  /** Parse a built HTML file. */
  html(path: string): ReturnType<typeof parse>;
}

const root = resolve(import.meta.dirname, "..");
const buildsDir = join(root, "node_modules", ".cache", "test-builds");

/** Build the site into a temp dir and return a reader over the output. */
export function buildSite(options: BuildOptions = {}): Site {
  // Inside the project, so Astro keeps its prerender chunks in outDir. Outside it, every build
  // shares ./.astro/.prerender, and test files building at once break each other.
  mkdirSync(buildsDir, { recursive: true });
  const outDir = mkdtempSync(join(buildsDir, "build-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.contentDir) env.CONTENT_DIR = resolve(options.contentDir);
  if (options.mode) env.BUILD_MODE = options.mode;
  env.ASTRO_CACHE_DIR = `${outDir}-cache`;
  execFileSync(
    "npx",
    ["astro", "build", "--outDir", outDir, "--silent"],
    { cwd: root, env, stdio: "pipe" },
  );
  const read = (path: string) => readFileSync(join(outDir, path), "utf8");
  return { outDir, read, html: (path) => parse(read(path)) };
}

/** All CSS shipped with the page: inline <style> blocks plus linked stylesheets. */
export function pageCss(site: Site, page = "index.html"): string {
  const doc = site.html(page);
  const inline = doc.querySelectorAll("style").map((s) => s.text);
  const linked = doc
    .querySelectorAll('link[rel="stylesheet"]')
    .map((l) => site.read(l.getAttribute("href")!.replace(/^\//, "")));
  return [...inline, ...linked].join("\n");
}
