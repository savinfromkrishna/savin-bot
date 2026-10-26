import { createHash, createHmac, randomBytes } from "node:crypto";

// ---------- Google OAuth (YouTube) ----------

export type GoogleClient = { clientId: string; clientSecret: string; redirectUri: string };
export type GoogleGrant = { accessToken: string; refreshToken: string | null; expiresAt: number };

const base64url = (buffer: Buffer) => buffer.toString("base64url");

/** Starts an authorization-code flow with PKCE; the verifier stays on the server. */
export function googleAuthorization(client: GoogleClient, scopes: string[]) {
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch) {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(`Google sign-in failed: ${data.error_description ?? data.error ?? response.status}`);
  }
  return data;
}

export async function googleExchange(client: GoogleClient, code: string, verifier: string, fetchImpl = fetch) {
  const data = await tokenRequest(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: client.redirectUri,
    },
    fetchImpl,
  );
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  } satisfies GoogleGrant;
}

/** Returns a grant that is valid for at least another minute, refreshing it if needed. */
export async function freshGoogleGrant(client: GoogleClient, grant: GoogleGrant, fetchImpl = fetch) {
  if (grant.expiresAt - Date.now() > 60_000) return { grant, changed: false };
  if (!grant.refreshToken) throw new Error("The Google sign-in expired; reconnect the integration");
  const data = await tokenRequest(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: grant.refreshToken,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
  return {
    grant: {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token ?? grant.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    },
    changed: true,
  };
}

// ---------- OAuth 1.0a request signing (X) ----------

export type OAuth1Keys = { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string };

/** RFC 3986 encoding, as OAuth 1.0a requires. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for a request; JSON bodies are not part of the signature. */
export function oauth1Header(
  method: string,
  url: string,
  keys: OAuth1Keys,
  extra: { nonce?: string; timestamp?: string; params?: Record<string, string> } = {},
) {
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: extra.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: extra.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: keys.token,
    oauth_version: "1.0",
  };
  const target = new URL(url);
  const pairs = [...target.searchParams.entries(), ...Object.entries(extra.params ?? {}), ...Object.entries(oauth)]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak < bk ? -1 : 1));
  const parameters = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const signatureBase = [method.toUpperCase(), encode(`${target.origin}${target.pathname}`), encode(parameters)].join(
    "&",
  );
  const signature = createHmac("sha1", `${encode(keys.consumerSecret)}&${encode(keys.tokenSecret)}`)
    .update(signatureBase)
    .digest("base64");
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature })
    .map(([key, value]) => `${encode(key)}="${encode(value)}"`)
    .join(", ")}`;
}
