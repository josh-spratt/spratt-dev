// Fails if any internal link or asset reference in the built output is broken.
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "node-html-parser";

const dir = resolve(process.argv[2] ?? "dist");

function* htmlFiles(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (f.endsWith(".html")) yield p;
  }
}

function exists(path) {
  const p = join(dir, path);
  if (existsSync(p) && statSync(p).isFile()) return true;
  return existsSync(join(p, "index.html"));
}

const broken = [];
for (const file of htmlFiles(dir)) {
  const pageUrl = new URL("/" + file.slice(dir.length + 1), "http://local");
  const root = parse(readFileSync(file, "utf8"));
  const refs = root.querySelectorAll("[href], [src]");
  for (const el of refs) {
    const ref = el.getAttribute("href") ?? el.getAttribute("src");
    if (!ref || /^(mailto:|tel:|data:|javascript:|#)/.test(ref)) continue;
    const url = new URL(ref, pageUrl);
    if (url.origin !== "http://local" && url.origin !== "https://jspratt.dev") continue;
    const path = decodeURIComponent(url.pathname);
    if (!exists(path)) broken.push(`${file.slice(dir.length)}: ${ref}`);
    else if (url.hash && url.hash.length > 1) {
      const target = path.endsWith("/") ? join(dir, path, "index.html") : join(dir, path);
      if (target.endsWith(".html") && !parse(readFileSync(target, "utf8")).querySelector(`[id="${decodeURIComponent(url.hash.slice(1))}"]`))
        broken.push(`${file.slice(dir.length)}: ${ref} (missing anchor)`);
    }
  }
}
if (broken.length) {
  console.error("Broken internal links:\n" + broken.join("\n"));
  process.exit(1);
}
console.log("Internal links OK");
