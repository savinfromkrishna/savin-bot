import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Accounts } from "../src/server/accounts.ts";
import { createAuth } from "../src/server/auth.ts";
import { Secrets } from "../src/server/secrets.ts";
import { createServerApp } from "../src/server/server.ts";
import { Spaces } from "../src/server/spaces.ts";
import { freshState } from "../src/server/store.ts";
import type { ComputerDriver } from "../src/server/tools/computer.ts";
import { Voice } from "../src/server/voice.ts";
import type { AppState, Me, SpaceSummary } from "../src/shared/contracts.ts";

const ORIGIN = "http://127.0.0.1:4310";
const fail = async () => {
  throw new Error("No desktop in tests");
};
const computer: ComputerDriver = {
  name: "none",
  available: false,
  screenshot: fail,
  click: fail,
  type: fail,
  key: fail,
  scroll: fail,
};
const open: Spaces[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((spaces) => spaces.closeAll()));
});

async function server(dataDir = mkdtempSync(join(tmpdir(), "savin-social-accounts-")), rateLimit = false) {
  const secrets = Secrets.open(join(dataDir, "secret.key"));
  const accounts = new Accounts(join(dataDir, "accounts"), secrets);
  const spaces: Spaces = await Spaces.load(dataDir, {
    secrets,
    accounts,
    computer,
    redirectUri: `${ORIGIN}/api/oauth/google/callback`,
    browser: { headless: true },
    forgetProvider: (ownerId, provider) => spaces.forgetProvider(ownerId, provider),
    voice: new Voice(join(dataDir, "voice"), { assets: null }),
  });
  open.push(spaces);
  const auth = await createAuth({
    dataDir,
    origins: [ORIGIN],
    onUserCreated: (user) => spaces.bootstrap(user),
    database: new DatabaseSync(":memory:"),
    rateLimit,
  });
  const app = createServerApp({ auth, spaces });
  const request = (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { host: "127.0.0.1:4310", origin: ORIGIN, "content-type": "application/json", cookie, ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  const signUp = async (email: string, name = "Kanha") => {
    const response = await request("POST", "/api/auth/sign-up/email", "", { name, email, password: "password123" });
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  };
  const me = async (cookie: string) => (await (await request("GET", "/api/me", cookie)).json()) as Me;
  const state = async (cookie: string, spaceId: string) =>
    (await (await request("GET", `/api/s/${spaceId}/state`, cookie)).json()) as AppState;
  return { app, request, signUp, me, state, spaces, accounts, dataDir };
}

describe("accounts and spaces", () => {
  it("signs a new account in with a Personal space and the social media team", async () => {
    const { request, signUp, me, state } = await server();
    expect((await request("GET", "/api/me", "")).status).toBe(401);
    const cookie = await signUp("kanha@example.com");
    const account = await me(cookie);
    expect(account.user).toMatchObject({ name: "Kanha", email: "kanha@example.com" });
    expect(account.spaces).toHaveLength(1);
    const [personal] = account.spaces as [SpaceSummary];
    expect(personal).toMatchObject({ name: "Personal", isDefault: true });
    expect(personal.bots.map((bot) => bot.id)).toEqual([
      "director",
      "scout",
      "writer",
      "editor",
      "producer",
      "publisher",
      "community",
    ]);
    expect((await state(cookie, personal.id)).space).toEqual({
      id: personal.id,
      name: "Personal",
      isDefault: true,
      kind: "social",
    });

    expect((await request("POST", "/api/auth/sign-out", cookie)).status).toBe(200);
    expect((await request("GET", "/api/me", cookie)).status).toBe(401);
  });

  it("slows down password guessing", async () => {
    const { request, signUp } = await server(undefined, true);
    await signUp("guess@example.com");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request("POST", "/api/auth/sign-in/email", "", {
        email: "guess@example.com",
        password: "wrong-password",
      });
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("makes a job search space with its own team, locked out of the terminal and desktop", async () => {
    const { request, signUp, state } = await server();
    const cookie = await signUp("jobs@example.com");
    const created = (await (
      await request("POST", "/api/spaces", cookie, { name: "Job hunt", kind: "jobs" })
    ).json()) as SpaceSummary;
    expect(created).toMatchObject({ name: "Job hunt", kind: "jobs", isDefault: false });
    expect(created.bots.map((bot) => bot.id)).toEqual(["coordinator", "finder", "tailor", "applier"]);
    const jobs = await state(cookie, created.id);
    expect(jobs.space.kind).toBe("jobs");
    expect(jobs.bots.some((bot) => bot.tools.shell || bot.tools.screen)).toBe(false);
    const saved = await request("PUT", `/api/s/${created.id}/candidate`, cookie, { ...jobs.candidate, name: "Kanha" });
    expect(saved.status).toBe(200);
    expect((await state(cookie, created.id)).candidate.name).toBe("Kanha");
  });

  it("lets a voice recording through to its own space, and only with the upload header", async () => {
    const { app, signUp, me } = await server();
    const cookie = await signUp("voice@example.com");
    const [personal] = (await me(cookie)).spaces as [SpaceSummary];
    const other = await signUp("other@example.com");
    const send = (who: string, headers: Record<string, string>) =>
      app.request(`/api/s/${personal.id}/voice/transcribe`, {
        method: "POST",
        headers: { host: "127.0.0.1:4310", origin: ORIGIN, "content-type": "audio/webm", cookie: who, ...headers },
        body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
      });
    expect((await send(cookie, {})).status).toBe(415);
    expect((await send(other, { "x-savin-upload": "1" })).status).toBe(404);
    // It reaches the space's own API, which says this test machine has no speech model.
    const reached = await send(cookie, { "x-savin-upload": "1" });
    expect(reached.status).toBe(503);
    expect((await reached.json()).error).toMatch(/isn't available on this system/);
  });

  it("keeps each account's spaces to itself", async () => {
    const { request, signUp, me } = await server();
    const first = await signUp("first@example.com");
    const second = await signUp("second@example.com", "Second");
    const [firstSpace] = (await me(first)).spaces as [SpaceSummary];
    expect((await request("GET", `/api/s/${firstSpace.id}/state`, second)).status).toBe(404);
    expect((await request("PATCH", `/api/spaces/${firstSpace.id}`, second, { name: "Mine" })).status).toBe(404);
    expect(
      (await request("GET", `/api/s/${firstSpace.id}/state`, first, undefined, { host: "evil.example" })).status,
    ).toBe(403);
    expect((await me(second)).spaces).toHaveLength(1);
  });

  it("creates, renames and deletes spaces, and keeps the first one", async () => {
    const { request, signUp, me, state } = await server();
    const cookie = await signUp("kanha@example.com");
    const [personal] = (await me(cookie)).spaces as [SpaceSummary];
    await request("POST", `/api/s/${personal.id}/models/connect`, cookie, {
      provider: "openai",
      apiKey: "sk-test-1234",
      model: "gpt-4.1",
    });
    const created = await request("POST", "/api/spaces", cookie, { name: "Cooking channel", team: false });
    expect(created.status).toBe(201);
    const cooking: SpaceSummary = await created.json();
    expect(cooking).toMatchObject({ name: "Cooking channel", isDefault: false, bots: [] });
    // A new space starts on the account's model.
    expect((await state(cookie, cooking.id)).models.active).toEqual({ providerId: "openai", model: "gpt-4.1" });

    expect((await request("POST", `/api/s/${cooking.id}/team`, cookie)).status).toBe(201);
    expect((await state(cookie, cooking.id)).bots).toHaveLength(7);
    await request("PATCH", `/api/spaces/${cooking.id}`, cookie, { name: "Baking channel" });
    expect((await me(cookie)).spaces.map((space) => space.name)).toEqual(["Personal", "Baking channel"]);

    expect((await request("DELETE", `/api/spaces/${personal.id}`, cookie)).status).toBe(422);
    expect((await request("DELETE", `/api/spaces/${cooking.id}`, cookie)).status).toBe(200);
    expect((await me(cookie)).spaces.map((space) => space.name)).toEqual(["Personal"]);
  });

  it("connects YouTube through Google's redirect, which arrives without a session", async () => {
    const { app, request, signUp, me, state } = await server();
    const cookie = await signUp("kanha@example.com");
    const [personal] = (await me(cookie)).spaces as [SpaceSummary];
    await request("PUT", `/api/s/${personal.id}/google`, cookie, {
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    const begin = await request("POST", `/api/s/${personal.id}/connections/google`, cookie, {
      connectorId: "youtube",
      agents: ["publisher"],
    });
    const { url } = (await begin.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/oauth/google/callback`);

    vi.stubGlobal("fetch", async (target: string) =>
      target === "https://oauth2.googleapis.com/token"
        ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
        : Response.json({ items: [{ snippet: { title: "Brew Lab" } }] }),
    );
    const callback = await app.request(
      `/api/oauth/google/callback?state=${authorize.searchParams.get("state")}&code=the-code`,
      { headers: { host: "127.0.0.1:4310" } },
    );
    vi.unstubAllGlobals();
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Brew Lab is connected");
    expect((await state(cookie, personal.id)).connections).toMatchObject([
      { connectorId: "youtube", status: "connected", account: "Brew Lab" },
    ]);
  });

  it("clears a disconnected model from every space of the account", async () => {
    const { request, signUp, me, state } = await server();
    const cookie = await signUp("kanha@example.com");
    const [personal] = (await me(cookie)).spaces as [SpaceSummary];
    await request("POST", `/api/s/${personal.id}/models/connect`, cookie, {
      provider: "openai",
      apiKey: "sk-test-1234",
      model: "gpt-4.1",
    });
    const other: SpaceSummary = await (
      await request("POST", "/api/spaces", cookie, { name: "Other", team: true })
    ).json();
    expect((await state(cookie, other.id)).models.connections).toHaveLength(1);
    await request("DELETE", `/api/s/${other.id}/models/connections/openai`, cookie);
    for (const id of [personal.id, other.id]) {
      expect((await state(cookie, id)).models).toMatchObject({ connections: [], active: null });
    }
  });

  it("gives the first account what the single-space version stored", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "savin-social-legacy-"));
    const legacy = freshState(true);
    writeFileSync(
      join(dataDir, "state.json"),
      JSON.stringify({
        ...legacy,
        version: 2,
        profile: { ...legacy.profile, brand: "Brew Lab" },
        bots: Object.fromEntries(
          Object.entries(legacy.bots).map(([id, { role: _r, supervisor: _s, createdAt: _c, ...record }]) => [
            id,
            id === "writer"
              ? { ...record, memory: { text: "Short hooks win.", revision: 1, updatedAt: null } }
              : record,
          ]),
        ),
        providers: [],
        preferences: { theme: "dark", sendWithEnter: false, showToolActivity: true, density: "compact" },
        google: { clientId: "client-id", clientSecret: null },
      }),
    );
    mkdirSync(join(dataDir, "workspace", "posts"), { recursive: true });
    writeFileSync(join(dataDir, "workspace", "posts", "idea.md"), "# Idea");

    const { signUp, me, state, accounts } = await server(dataDir);
    const first = await signUp("kanha@example.com");
    const [personal] = (await me(first)).spaces as [SpaceSummary];
    const adopted = await state(first, personal.id);
    expect(adopted.profile.brand).toBe("Brew Lab");
    expect(adopted.bots.find((bot) => bot.id === "writer")).toMatchObject({
      role: "writer",
      memory: { text: "Short hooks win." },
    });
    expect(adopted.preferences).toMatchObject({ theme: "dark", density: "compact" });
    expect(readFileSync(join(dataDir, "spaces", personal.id, "workspace", "posts", "idea.md"), "utf8")).toBe("# Idea");
    const user = (await me(first)).user;
    expect(accounts.get(user.id).google.clientId).toBe("client-id");

    // Later accounts start fresh.
    const second = await signUp("second@example.com", "Second");
    const [theirs] = (await me(second)).spaces as [SpaceSummary];
    expect((await state(second, theirs.id)).profile.brand).toBe("My Channel");
  });
});
