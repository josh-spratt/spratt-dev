// Draws a 1200×630 share card for every Post in content/posts into
// public/cards/<slug>.png, in the same layout as public/social.png: the Post's
// picture in the yellow studded column, its title on the right.
//
//   npm run cards            # draw cards that are missing
//   npm run cards -- --all   # redraw every card (after changing this script)
//
// Cards are committed, not drawn during the build, so the text is set with the
// fonts on this machine rather than whatever the build server has.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const postsDir = join(root, "content/posts");
const outDir = join(root, "public/cards");
const redrawAll = process.argv.includes("--all");

const W = 1200;
const H = 630;
const COLUMN = 420;
const INK = "#15151a";
const PAGE = "#fffdf7";
const BAND = "#f2c230";
const RED = "#e8412f";
const FONT = "Helvetica Neue";

/** The few frontmatter fields this needs; Posts use simple `key: value` lines. */
function frontmatter(file) {
  const src = readFileSync(file, "utf8");
  const block = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const data = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) data[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return data;
}

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function background() {
  const studs = [];
  for (let y = 20; y < H; y += 40) {
    for (let x = 20; x < COLUMN; x += 40) studs.push(`<circle cx="${x}" cy="${y}" r="10"/>`);
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${PAGE}"/>
  <rect width="${COLUMN}" height="${H}" fill="${BAND}"/>
  <g fill="#000" fill-opacity="0.08">${studs.join("")}</g>
  <rect x="${COLUMN}" width="4" height="${H}" fill="${INK}"/>
</svg>`);
}

/** The Post's picture at 2×, kept crisp, in an outlined tile with a red offset shadow. */
async function picture(image) {
  const art = 352;
  const pad = 6;
  const tile = art + pad * 2;
  const pixels = await sharp(join(root, "public", image))
    .resize(art, art, { kernel: "nearest" })
    .png()
    .toBuffer();
  const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tile + 12}" height="${tile + 12}">
  <rect x="12" y="12" width="${tile}" height="${tile}" rx="16" fill="${RED}" stroke="${INK}" stroke-width="5"/>
  <rect x="2.5" y="2.5" width="${tile - 5}" height="${tile - 5}" rx="14" fill="#fff" stroke="${INK}" stroke-width="5"/>
</svg>`);
  const x = Math.round((COLUMN - tile) / 2);
  const y = Math.round((H - tile) / 2);
  return [
    { input: frame, left: x, top: y },
    { input: pixels, left: x + pad, top: y + pad },
  ];
}

/** Title set by Pango so it wraps; shrinks a step at a time until it fits. */
async function title(text) {
  const width = W - COLUMN - 160;
  for (let size = 76; size >= 40; size -= 4) {
    const { data, info } = await sharp({
      text: {
        text: `<span foreground="${INK}" font_desc="${FONT} Bold ${size}px" letter_spacing="-1024">${escape(text)}</span>`,
        rgba: true,
        width,
        spacing: Math.round(size * 0.12),
        wrap: "word",
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (info.height <= 300) return { data, height: info.height };
  }
  throw new Error(`Title too long for a card: ${text}`);
}

async function caption() {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="#4d4a42" font_desc="${FONT} Bold 34px">jspratt.dev</span>`,
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, height: info.height };
}

async function draw(slug, post) {
  const head = await title(post.title);
  const foot = await caption();
  const gap = 44;
  const top = Math.round((H - head.height - gap - foot.height) / 2);
  const left = COLUMN + 80;
  const layers = [
    ...(post.image ? await picture(post.image) : []),
    { input: head.data, left, top },
    { input: foot.data, left, top: top + head.height + gap },
  ];
  const out = join(outDir, `${slug}.png`);
  await sharp(background()).composite(layers).png({ compressionLevel: 9, palette: true }).toFile(out);
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(postsDir).filter((f) => f.endsWith(".md"))) {
  const slug = file.replace(/\.md$/, "");
  const out = join(outDir, `${slug}.png`);
  if (!redrawAll && existsSync(out)) continue;
  const post = frontmatter(join(postsDir, file));
  if (!post.title) throw new Error(`${file}: no title`);
  console.log(`drew ${await draw(slug, post)}`);
}
