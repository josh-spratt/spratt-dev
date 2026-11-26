// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://jspratt.dev",
  output: "static",
  trailingSlash: "always",
  // /out/<name>/ pages are Click out redirects, not pages of the site.
  integrations: [sitemap({ filter: (page) => !new URL(page).pathname.startsWith("/out/") })],
  // Code colours come from --astro-code-* tokens in global.css, so they are contrast-checked.
  markdown: { shikiConfig: { theme: "css-variables" } },
});
