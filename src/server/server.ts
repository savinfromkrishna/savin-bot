import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import type { Me } from "../shared/contracts.ts";
import { SpaceInput } from "../shared/contracts.ts";
import type { Auth, AuthUser } from "./auth.ts";
import { CLIENT_IP_HEADER, userOf } from "./auth.ts";
import { localHost, MAX_JSON_BYTES } from "./http.ts";
import { callbackPage } from "./routes/integrations.ts";
import { body, HttpError } from "./routes/util.ts";
import type { Spaces } from "./spaces.ts";
import { SpaceError } from "./spaces.ts";

type Env = { Bindings: HttpBindings; Variables: { user: AuthUser } };

/**
 * The server in front of the spaces: Better Auth's sign-in and sign-up, your spaces, and each
 * space's own API under /api/s/{space}/, reachable only by the account that owns it.
 */
export function createServerApp({ auth, spaces }: { auth: Auth; spaces: Spaces }) {
  const app = new Hono<Env>();

  // Only this machine's own pages: the host check stops DNS rebinding, and writes must be JSON
  // (or a raw upload with a custom header), so another site's form can never post here.
  app.use("/api/*", async (c, next) => {
    if (!localHost.test(c.req.header("host") ?? "")) return c.json({ error: "Forbidden host" }, 403);
    const json = c.req.header("content-type")?.startsWith("application/json");
    const upload =
      /^\/api\/s\/[\w-]+\/(?:files\/upload|voice\/transcribe)$/.test(c.req.path) &&
      c.req.header("x-savin-upload") === "1";
    const authCall = c.req.path.startsWith("/api/auth/");
    if (!["GET", "HEAD"].includes(c.req.method) && !json && !upload && !authCall) {
      return c.json({ error: "Expected JSON" }, 415);
    }
    // Each space's API also counts bodies sent without a length; this stops the obvious ones early.
    if (!upload && Number(c.req.header("content-length") ?? 0) > MAX_JSON_BYTES) {
      return c.json({ error: "That is too much to send at once. Attach it as a file instead." }, 413);
    }
    await next();
    c.header("cache-control", "no-store");
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof SpaceError) return c.json({ error: error.message }, 422);
    if (error instanceof z.ZodError) return c.json({ error: z.prettifyError(error) }, 400);
    return c.json({ error: error.message }, 500);
  });

  // Better Auth checks the request's origin itself; it learns the caller's address from the
  // connection, for its sign-in rate limits, never from a header the caller sent.
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const headers = new Headers(c.req.raw.headers);
    // Tests call the app without a socket; everything else arrives over one.
    headers.set(CLIENT_IP_HEADER, c.env?.incoming?.socket.remoteAddress ?? "127.0.0.1");
    const hasBody = c.req.method === "POST";
    return auth.handler(
      new Request(c.req.raw.url, {
        method: c.req.method,
        headers,
        body: hasBody ? c.req.raw.body : undefined,
        signal: c.req.raw.signal,
        ...(hasBody && { duplex: "half" }),
      } as RequestInit),
    );
  });

  // Google returns to a fixed address without a session, so the sign-in's state finds its space.
  app.get("/api/oauth/google/callback", (c) => {
    const space = spaces.forGoogle(c.req.query("state") ?? "");
    if (!space) return c.html(callbackPage("Couldn't connect", "This sign-in link expired. Start again."), 400);
    return space.app.fetch(c.req.raw);
  });

  app.use("/api/*", async (c, next) => {
    const user = await userOf(auth, c.req.raw.headers);
    if (!user) return c.json({ error: "Sign in again" }, 401);
    c.set("user", user);
    await next();
  });

  const owned = (id: string, user: AuthUser) => {
    const space = spaces.get(id);
    if (!space || space.record.ownerId !== user.id) throw new HttpError(404, "No such space");
    return space;
  };

  app.get("/api/me", (c) => {
    const user = c.get("user");
    return c.json({ user, spaces: spaces.ownedBy(user.id).map((space) => space.summary()) } satisfies Me);
  });

  /** "New space": empty, or with the social media team set up from its brand. */
  app.post("/api/spaces", async (c) => {
    const input = await body(c, SpaceInput);
    const space = await spaces.create(c.get("user").id, input.name, { team: input.team, kind: input.kind });
    return c.json(space.summary(), 201);
  });

  app.patch("/api/spaces/:id", async (c) => {
    const { name } = await body(c, SpaceInput.pick({ name: true }));
    await spaces.rename(owned(c.req.param("id"), c.get("user")).record.id, name);
    return c.json({ saved: true });
  });

  app.delete("/api/spaces/:id", async (c) => {
    await spaces.remove(owned(c.req.param("id"), c.get("user")).record.id);
    return c.json({ deleted: true });
  });

  app.all("/api/s/:spaceId/*", (c) => {
    const space = owned(c.req.param("spaceId"), c.get("user"));
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/api\/s\/[^/]+/, "/api");
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    return space.app.fetch(
      new Request(url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: hasBody ? c.req.raw.body : undefined,
        signal: c.req.raw.signal,
        ...(hasBody && { duplex: "half" }),
      } as RequestInit),
    );
  });

  return app;
}
