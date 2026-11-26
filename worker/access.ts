/**
 * Cloudflare Access in front of /stats/ (docs/adr/0002-cloudflare-access-for-stats.md).
 * Access signs Josh in before the request reaches the Worker and adds a signed
 * JWT in the Cf-Access-Jwt-Assertion header. The Worker checks that JWT itself,
 * so a request that skipped Access (a misconfigured policy, a preview URL) is
 * still refused. Pure helpers only, apart from fetching the team's public keys.
 */

export const ACCESS_HEADER = "cf-access-jwt-assertion";

/** The two Worker secrets the check needs. Either missing means nothing opens. */
export interface AccessConfig {
  /** The team domain, e.g. "jspratt.cloudflareaccess.com" (https:// optional). */
  team: string;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string;
}

/** The config from the Worker's env, or null when either part is unset or blank: fail closed. */
export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }): AccessConfig | null {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  return team && aud ? { team, aud } : null;
}

/** "jspratt.cloudflareaccess.com" → "https://jspratt.cloudflareaccess.com", the JWT's issuer. */
export function teamOrigin(team: string): string {
  const withScheme = /^https?:\/\//.test(team) ? team : `https://${team}`;
  return new URL(withScheme).origin;
}

export function certsUrl(team: string): string {
  return `${teamOrigin(team)}/cdn-cgi/access/certs`;
}

/** A public key from the team's certs, as JSON Web Key. */
export interface AccessKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

/** What a valid Access JWT says, as far as the Worker cares. */
export interface AccessClaims {
  email?: string;
  sub?: string;
}

function base64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(base64url(part)));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Clock skew allowed on exp and nbf, in seconds. */
const LEEWAY_S = 60;

/**
 * Checks an Access JWT: RS256, signed by one of the team's keys, issued by the
 * team, for this application's AUD, and not expired. Returns its claims, or
 * null for anything else.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  keys: AccessKey[],
  now = Date.now(),
): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload || header.alg !== "RS256") return null;
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(s), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    return null;
  }
  if (!ok) return null;

  const seconds = now / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(config.aud)) return null;
  if (payload.iss !== teamOrigin(config.team)) return null;
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > seconds) return null;
  return {
    email: typeof payload.email === "string" ? payload.email : undefined,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
  };
}

/** The keys in a certs response ({ keys: [...] }), skipping anything that isn't an RSA key. */
export function parseKeys(data: unknown): AccessKey[] {
  const keys = (data as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (k): k is AccessKey =>
      !!k && typeof k === "object" && typeof k.kid === "string" && k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string",
  );
}

// The team's keys change rarely (Cloudflare rotates them every few weeks and
// publishes the next one early), so one isolate fetches them at most once an
// hour, and again straight away for a kid it hasn't seen.
const CACHE_MS = 60 * 60 * 1000;
let cached: { url: string; keys: AccessKey[]; at: number } | null = null;

async function fetchKeys(url: string): Promise<AccessKey[]> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  return parseKeys(await res.json());
}

function kidOf(token: string): string | null {
  const kid = decodeJson(token.split(".")[0] ?? "")?.kid;
  return typeof kid === "string" ? kid : null;
}

/**
 * The request's Access identity, or null: no config, no header, a JWT that
 * doesn't verify, or the certs can't be fetched. Every failure is a refusal.
 */
export async function accessIdentity(request: Request, config: AccessConfig | null): Promise<AccessClaims | null> {
  if (!config) return null;
  const token = request.headers.get(ACCESS_HEADER);
  if (!token) return null;
  const url = certsUrl(config.team);
  try {
    const kid = kidOf(token);
    let keys = cached && cached.url === url && Date.now() - cached.at < CACHE_MS ? cached.keys : null;
    if (!keys?.some((k) => k.kid === kid)) {
      keys = await fetchKeys(url);
      cached = { url, keys, at: Date.now() };
    }
    return await verifyAccessJwt(token, config, keys);
  } catch (err) {
    console.error("access check failed", err);
    return null;
  }
}
