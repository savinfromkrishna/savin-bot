import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { googleAuthorization, oauth1Header } from "../src/server/integrations/auth.ts";
import { catalog } from "../src/server/integrations/connectors.ts";
import { cleanSchema, McpServers, mcpToolName } from "../src/server/integrations/mcp.ts";
import { Integrations } from "../src/server/integrations/service.ts";
import { Secrets } from "../src/server/secrets.ts";
import { Store } from "../src/server/store.ts";
import type { ToolContext } from "../src/server/tools/tool.ts";

async function integrations() {
  const dataDir = mkdtempSync(join(tmpdir(), "savin-social-integrations-"));
  const store = await Store.open(dataDir, Secrets.open(join(dataDir, "secret.key")));
  const mcp = new McpServers({
    open: (record) => (record.secret ? store.secrets.open(record.secret) : {}),
    onChange: () => {},
    cwd: dataDir,
  });
  const service = new Integrations({
    store,
    mcp,
    redirectUri: "http://127.0.0.1:4310/api/oauth/google/callback",
    onChange: () => {},
    google: () => ({ clientId: null, clientSecret: null }),
  });
  return { store, mcp, service, dataDir };
}

const context = (workspaceDir: string): ToolContext => ({
  runId: "run",
  botId: "community",
  signal: new AbortController().signal,
  workspaceDir,
  credentials: [],
  delegate: async () => "",
  handoff: async () => "",
  requestApproval: async () => true,
  requestTakeover: async () => true,
  waitForControl: async () => {},
  activity: () => {},
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("integrations", () => {
  it("lists a catalog where every app says how it authenticates and what its tools change", () => {
    const items = catalog();
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "youtube",
        "instagram",
        "x",
        "linkedin",
        "telegram",
        "discord",
        "slack",
        "webhook",
        "pexels",
        "elevenlabs",
        "custom-api",
      ]),
    );
    const youtube = items.find((item) => item.id === "youtube");
    expect(youtube?.auth.kind).toBe("google");
    expect(youtube?.tools.find((tool) => tool.name === "youtube_upload_video")?.readOnly).toBe(false);
    expect(youtube?.tools.find((tool) => tool.name === "youtube_channel_stats")?.readOnly).toBe(true);
  });

  it("verifies credentials before saving them encrypted, and gives each account its own tool names", async () => {
    const { store, service, dataDir } = await integrations();
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/getMe")) return json({ result: { username: "brew_bot" } });
      return json({ ok: true });
    });

    const first = await service.connect({
      connectorId: "telegram",
      fields: { token: "123:SECRET", chatId: "@brew" },
      agents: ["community"],
    });
    expect(first).toMatchObject({ label: "Telegram", account: "@brew_bot", status: "connected" });
    expect(JSON.stringify(store.state.connections)).not.toContain("123:SECRET");

    const second = await service.connect({
      connectorId: "telegram",
      fields: { token: "456:OTHER" },
      agents: ["community", "director"],
    });
    expect(second.label).toBe("Telegram 2");
    expect(service.toolsFor("community").map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["telegram_send_message", "telegram_2_send_message"]),
    );
    expect(service.toolsFor("director").map((tool) => tool.name)).not.toContain("telegram_send_message");
    expect(service.toolsFor("writer")).toEqual([]);

    const send = service.toolsFor("community").find((tool) => tool.name === "telegram_send_message");
    expect(send).toMatchObject({ connectorId: "telegram", category: "message", readOnly: undefined });
    await send?.run({ text: "New Short is up!" }, context(dataDir));
    expect(requests).toContain("POST https://api.telegram.org/bot123:SECRET/sendMessage");
    expect(service.views()[0]?.activity[0]).toMatchObject({ tool: "send_message", ok: true });
  });

  it("refuses to save credentials the app rejects", async () => {
    const { service, store } = await integrations();
    vi.stubGlobal("fetch", async () => json({ ok: false, description: "Unauthorized" }, 401));
    await expect(service.connect({ connectorId: "telegram", fields: { token: "bad" }, agents: [] })).rejects.toThrow(
      /401/,
    );
    expect(store.state.connections).toEqual([]);
  });

  it("signs X requests with OAuth 1.0a exactly as the reference example", () => {
    const header = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      {
        nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        timestamp: "1318622958",
        params: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      },
    );
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  it("starts Google sign-in with PKCE and offline access", () => {
    const authorization = googleAuthorization(
      { clientId: "client", clientSecret: "secret", redirectUri: "http://127.0.0.1:4310/cb" },
      ["https://www.googleapis.com/auth/youtube.upload"],
    );
    const url = new URL(authorization.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe(authorization.state);
    expect(url.searchParams.get("client_secret")).toBeNull();
  });

  it("asks for Google setup before a YouTube sign-in can start", async () => {
    const { service } = await integrations();
    await expect(service.beginGoogle("youtube", ["publisher"])).rejects.toThrow(/Set up Google sign-in/);
  });

  describe("YouTube sign-in", () => {
    const redirectUri = "http://127.0.0.1:4310/api/oauth/google/callback";
    async function google() {
      const dataDir = mkdtempSync(join(tmpdir(), "savin-social-google-"));
      const secrets = Secrets.open(join(dataDir, "secret.key"));
      const store = await Store.open(dataDir, secrets);
      const client = { clientId: "client-id", clientSecret: secrets.seal("client-secret") };
      // A new service over the same store is what a server restart looks like.
      const service = () =>
        new Integrations({
          store,
          mcp: new McpServers({ open: () => ({}), onChange: () => {}, cwd: dataDir }),
          redirectUri,
          onChange: () => {},
          google: () => client,
        });
      return { store, service };
    }
    const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";
    const googleApi = (channels: () => Response) => {
      const sent: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url === "https://oauth2.googleapis.com/token") {
          sent.push(String(init?.body));
          return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
        }
        if (url.includes("/youtube/v3/channels")) return channels();
        return json({}, 404);
      });
      return sent;
    };

    it("finishes after a server restart and names the channel", async () => {
      const { store, service } = await google();
      const { url } = await service().beginGoogle("youtube", ["publisher"]);
      const state = stateOf(url);
      expect(store.state.connections[0]?.pending?.verifier).toMatch(/^v1\./);

      const restarted = service();
      expect(restarted.owns(state)).toBe(true);
      const sent = googleApi(() => json({ items: [{ id: "UCbrew", snippet: { title: "Brew Lab" } }] }));
      expect(await restarted.completeGoogle(state, "the-code", null)).toBe("Brew Lab");
      // The first channel connected becomes the one uploads go to.
      expect(store.state.channel).toEqual({ id: "UCbrew", title: "Brew Lab" });
      expect(sent[0]).toContain("code_verifier=");
      expect(sent[0]).toContain("client_secret=client-secret");
      expect(restarted.views()[0]).toMatchObject({ status: "connected", account: "Brew Lab", error: null });
      expect(store.state.connections[0]?.pending).toBeNull();
      expect(restarted.toolsFor("publisher").map((tool) => tool.name)).toContain("youtube_upload_video");
      await expect(restarted.completeGoogle(state, "the-code", null)).rejects.toThrow(/expired/);

      // Uploads go to that channel only.
      await store.update((current) => ({ ...current, channel: { id: "UCother", title: "Someone else" } }));
      const upload = restarted.toolsFor("publisher").find((tool) => tool.name === "youtube_upload_video");
      await expect(
        upload?.run({ path: "v.mp4", title: "t", description: "", tags: [], privacy: "private" }, {} as ToolContext),
      ).rejects.toThrow("Uploads go only to Someone else; this account's channel is Brew Lab.");

      // A reconnect that Google refuses leaves the working account alone.
      const retry = await restarted.beginGoogle("youtube", ["publisher"], store.state.connections[0]?.id);
      await expect(restarted.completeGoogle(stateOf(retry.url), null, "access_denied")).rejects.toThrow(/cancelled/);
      expect(restarted.views()[0]).toMatchObject({ status: "connected", account: "Brew Lab" });
    });

    it("never leaves a sign-in waiting forever, and says what to fix", async () => {
      const { store, service } = await google();
      const integrations = service();
      const { url } = await integrations.beginGoogle("youtube", ["publisher"]);
      expect(integrations.views()[0]).toMatchObject({ status: "pending" });
      expect(integrations.toolsFor("publisher")).toEqual([]);
      await store.update((state) => ({
        ...state,
        connections: state.connections.map((record) => ({
          ...record,
          pending: record.pending && { ...record.pending, expires: Date.now() - 1 },
        })),
      }));
      expect(integrations.views()[0]).toMatchObject({ status: "error", error: "Sign-in didn't finish." });
      await expect(integrations.completeGoogle(stateOf(url), "code", null)).rejects.toThrow(/too long/);

      const disabled = await integrations.beginGoogle("youtube", ["publisher"], store.state.connections[0]?.id);
      googleApi(() =>
        json(
          {
            error: {
              code: 403,
              message: "YouTube Data API v3 has not been used in project 1 before or it is disabled.",
            },
          },
          403,
        ),
      );
      await expect(integrations.completeGoogle(stateOf(disabled.url), "code", null)).rejects.toThrow(
        "Turn on the YouTube Data API v3 in your Google Cloud project, then reconnect.",
      );
      expect(integrations.views()[0]).toMatchObject({ status: "error" });

      const noChannel = await integrations.beginGoogle("youtube", ["publisher"], store.state.connections[0]?.id);
      googleApi(() => json({ items: [] }));
      await expect(integrations.completeGoogle(stateOf(noChannel.url), "code", null)).rejects.toThrow(
        /no YouTube channel/,
      );
    });
  });

  describe("MCP servers", () => {
    const fixture = join(import.meta.dirname, "fixtures", "mcp-server.mjs");
    let cleanup: (() => Promise<void>) | undefined;
    afterAll(async () => cleanup?.());

    it("connects over stdio, exposes tools to the bots it is assigned to, and calls them", async () => {
      const { service, mcp, store, dataDir } = await integrations();
      cleanup = () => mcp.closeAll();
      await service.addMcpServer({
        name: "Video stats",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { FIXTURE_TOKEN: "tok-123" },
        agents: ["scout"],
      });
      const view = () => service.mcpViews()[0];
      for (let i = 0; i < 100 && view()?.status === "connecting"; i++)
        await new Promise((resolve) => setTimeout(resolve, 100));

      expect(view()).toMatchObject({
        status: "connected",
        slug: "video-stats",
        hasSecret: true,
        envKeys: ["FIXTURE_TOKEN"],
      });
      expect(JSON.stringify(store.state.mcpServers)).not.toContain("tok-123");
      const tools = service.toolsFor("scout");
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__video-stats__get_views", "mcp__video-stats__post_comment"]);
      expect(tools.map((tool) => tool.readOnly)).toEqual([true, false]);
      expect(tools[0]?.parameters).not.toHaveProperty("$schema");
      expect(tools[0]?.parameters).not.toHaveProperty("additionalProperties");
      expect(service.toolsFor("writer")).toEqual([]);

      const result = await tools[0]?.run({ id: "abc" }, context(dataDir));
      expect(result?.text).toBe("abc: 1234 views (tok-123)");
      expect((await tools[1]?.run({ text: "hi" }, context(dataDir)))?.text).toBe("posted hi");
    }, 30_000);

    it("keeps names and schemas within what model APIs accept", () => {
      expect(mcpToolName("srv", "a.b c/d")).toBe("mcp__srv__a_b_c_d");
      expect(mcpToolName("srv", "x".repeat(100))).toHaveLength(64);
      expect(
        cleanSchema({
          $schema: "x",
          type: "object",
          properties: { a: { type: "object", additionalProperties: false } },
        }),
      ).toEqual({
        type: "object",
        properties: { a: { type: "object" } },
      });
    });
  });
});
