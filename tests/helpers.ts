import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Build the site into a temp dir and return a reader over the output. */
export function buildSite(options: BuildOptions = {}): Site {
  const outDir = mkdtempSync(join(tmpdir(), "spratt-dev-build-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.contentDir) env.CONTENT_DIR = resolve(options.contentDir);
  if (options.mode) env.BUILD_MODE = options.mode;
  execFileSync(
    "npx",
    ["astro", "build", "--outDir", outDir, "--silent"],
    { cwd: root, env, stdio: "pipe" },
  );
  const read = (path: string) => readFileSync(join(outDir, path), "utf8");
  return { outDir, read, html: (path) => parse(read(path)) };
}
