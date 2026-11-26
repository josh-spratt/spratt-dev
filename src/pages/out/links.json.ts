import { outLinks } from "../../lib/site";

/**
 * Every Click out name and where it goes, for the Worker to look up /out/<name>/
 * in. Only names on this list redirect (worker/index.ts), so /out/ is not an
 * open redirect. The Worker reads it straight from the assets.
 */
export function GET() {
  return new Response(JSON.stringify(outLinks), { headers: { "content-type": "application/json" } });
}
