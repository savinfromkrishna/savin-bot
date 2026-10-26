import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Accounts } from "../src/server/accounts.ts";
import { botViews } from "../src/server/bots.ts";
import { createApp } from "../src/server/http.ts";
import { McpServers } from "../src/server/integrations/mcp.ts";
import { Integrations } from "../src/server/integrations/service.ts";
import { SkillLibrary } from "../src/server/library.ts";
import { mentioned } from "../src/server/routes/groups.ts";
import { Scheduler } from "../src/server/scheduler.ts";
import { withoutProvider } from "../src/server/store.ts";
import { Browsers } from "../src/server/tools/browser.ts";
import { shell } from "../src/server/tools/terminal.ts";
import { GEMINI_SIGN_IN } from "../src/server/tools/video.ts";
import { Workspace } from "../src/server/workspace/files.ts";
import { CommandLogs, Terminals } from "../src/server/workspace/terminals.ts";
import type { AppState, Bot, Group, Run, SignInBegin, SignInStatus } from "../src/shared/contracts.ts";
import { call, fakeTool, fakeVoice, reply, scripted, setup, until, webmRecording } from "./helpers.ts";

const OWNER = "owner-1";

/** A stand-in for a provider's sign-in: shows a device code, then stores a token once released. */
function fakeSignIn() {
  let release = () => {};
  const login = async (_userId: string, provider: string, interaction: AuthInteraction) => {
    interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.test/device" });
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      interaction.signal?.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true });
    });
    await accounts.credentials(OWNER).modify(provider, async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
    }));
  };
  let accounts: Accounts;
  return {
    login,
    bind: (bound: Accounts) => {
      accounts = bound;
    },
    finish: () => release(),
  };
}

async function server() {
  const context = await setup({
    provider: scripted((_bot, request) =>
      request.messages.some((message) => message.role === "tool")
        ? reply("done")
        : { content: "", toolCalls: [call("browser_click", {})] },
    ),
    tools: [fakeTool("browser_click", "browser")],
  });
  const { store, runtime, events, environment, dataDir, secrets } = context;
  const signIn = fakeSignIn();
  const accounts = new Accounts(join(dataDir, "accounts"), secrets, signIn.login);
  signIn.bind(accounts);
  const mcp = new McpServers({ open: () => ({}), onChange: () => {}, cwd: store.workspaceDir });
  const integrations = new Integrations({
    store,
    mcp,
    redirectUri: "http://127.0.0.1:4310/cb",
    onChange: () => {},
    google: () => accounts.get(OWNER).google,
  });
  const skills = new SkillLibrary(store.skillsDir);
  const voice = fakeVoice(join(context.dataDir, "voice"));
  const scheduler = new Scheduler(store, runtime);
  const opened: string[][] = [];
  // Real browsers that never start: opening a page only records where it would go.
  const browsers = new Browsers({
    dir: (id) => store.browserDir(id),
    known: (id) => store.state.browsers.some((browser) => browser.id === id),
    headless: true,
  });
  browsers.open = async (urls) => void opened.push(urls);
  const state = async (): Promise<AppState> => ({
    space: { id: "s1", name: "Personal", isDefault: true, kind: "social" },
    browserSignIns: [],
    browsers: [],
    channel: store.state.channel,
    candidate: store.state.candidate,
    applications: store.state.applications,
    habits: store.state.habits,
    groups: store.state.groups,
    profile: store.state.profile,
    bots: botViews(store.state),
    routines: store.state.routines,
    models: {
      connections: accounts.get(OWNER).connections,
      active: store.state.active,
      thinking: store.state.thinking,
      backups: store.state.backups,
    },
    connections: integrations.views(),
    mcpServers: integrations.mcpViews(),
    approvalRules: store.state.approvalRules,
    preferences: accounts.get(OWNER).preferences,
    google: { configured: false, clientId: null, redirectUri: "" },
    skills: await skills.list(),
    usage: store.state.usage,
    environment,
  });
  const { app } = createApp({
    store,
    runtime,
    scheduler,
    events,
    integrations,
    skills,
    browsers,
    workspace: {
      workspace: new Workspace(store.workspaceDir),
      terminals: new Terminals({ cwd: store.workspaceDir, shell, events }),
      commands: new CommandLogs(events),
    },
    accounts,
    ownerId: OWNER,
    forgetProvider: async (provider) => store.update((current) => withoutProvider(current, provider)),
    state,
    voice: voice.voice,
  });
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: {
        host: "127.0.0.1:4310",
        ...(body !== undefined && { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...context, accounts, signIn, request, opened, state, app, voice };
}

describe("http api", () => {
  it("only answers this machine's own pages", async () => {
    const { request } = await server();
    expect((await request("GET", "/api/state")).status).toBe(200);
    expect((await request("GET", "/api/state", undefined, { host: "evil.example" })).status).toBe(403);
    expect((await request("GET", "/api/state", undefined, { host: "127.0.0.1.evil.example" })).status).toBe(403);
    expect(
      (await request("POST", "/api/runs", undefined, { "content-type": "application/x-www-form-urlencoded" })).status,
    ).toBe(415);
    expect(
      (await request("PUT", "/api/files/upload?path=x.txt", undefined, { "content-type": "text/plain" })).status,
    ).toBe(415);
  });

  it("saves bot settings, records instruction history and resets to automatic", async () => {
    const { request, store } = await server();
    const edited = await (
      await request("PUT", "/api/bots/writer", {
        name: "Quill",
        instructions: "Short and punchy.",
        computerAccess: "ask",
        tools: { browser: true },
      })
    ).json();
    expect(edited).toMatchObject({
      name: "Quill",
      instructions: "Short and punchy.",
      instructionsAutomatic: false,
      computerAccess: "ask",
      tools: { browser: true, files: true },
    });
    expect(edited.instructionHistory[0]).toMatchObject({ reason: "Edited" });
    const reset = await (await request("PUT", "/api/bots/writer", { instructions: null })).json();
    expect(reset).toMatchObject({
      instructionsAutomatic: true,
      instructionHistory: [{ reason: "Reset to automatic", text: "Short and punchy." }, { reason: "Edited" }],
    });
    expect(store.state.bots.writer?.name).toBe("Quill");
    expect((await request("PUT", "/api/bots/nobody", { name: "x" })).status).toBe(404);
  });

  it("creates, duplicates and deletes bots, and brings the team back", async () => {
    const { request, store } = await server();
    const created: Bot = await (
      await request("POST", "/api/bots", { name: "Analyst", title: "Weekly numbers", description: "Pull stats." })
    ).json();
    expect(created).toMatchObject({
      role: null,
      supervisor: null,
      instructions: "Pull stats.",
      computerAccess: "full",
    });
    const copy: Bot = await (await request("POST", `/api/bots/${created.id}/duplicate`, {})).json();
    expect(copy).toMatchObject({ name: "Analyst copy", instructions: "Pull stats." });
    expect(copy.id).not.toBe(created.id);

    await request("POST", "/api/routines", {
      name: "Monday",
      botId: "community",
      instruction: "t",
      schedule: "0 9 * * 1",
      active: false,
      model: null,
    });
    expect((await request("DELETE", "/api/bots/community", {})).status).toBe(200);
    expect(store.state.bots.community).toBeUndefined();
    expect(store.state.routines.some((routine) => routine.botId === "community")).toBe(false);
    expect((await request("POST", "/api/runs", { botId: "community", task: "x" })).status).toBe(404);

    const { added } = await (await request("POST", "/api/team", {})).json();
    expect(added).toEqual(["community"]);
    expect(store.state.bots.community).toMatchObject({ role: "community", supervisor: "director" });
  });

  it("routes group messages to the mentioned bots, or the first member", async () => {
    const pair = [
      { id: "writer", name: "Writer" },
      { id: "editor", name: "Editor" },
    ];
    expect(mentioned("Plan the week", pair)).toEqual(["writer"]);
    expect(mentioned("@Editor cut this", pair)).toEqual(["editor"]);
    expect(mentioned("hey @everyone", pair)).toEqual(["writer", "editor"]);

    const { request, runtime, store } = await server();
    expect((await request("POST", "/api/groups", { name: "Solo", botIds: ["writer"] })).status).toBe(400);
    const created = await request("POST", "/api/groups", { name: "Launch", botIds: ["writer", "editor"] });
    expect(created.status).toBe(201);
    const group = (await created.json()) as Group;
    const sent = await request("POST", `/api/groups/${group.id}/messages`, { text: "@Editor make the thumbnail" });
    const { runs } = (await sent.json()) as { runs: Run[] };
    expect(runs.map((run) => [run.botId, run.groupId])).toEqual([["editor", group.id]]);
    for (const run of runs) runtime.cancel(run.id);
    await Promise.all(runs.map((run) => runtime.wait(run.id)));

    await request("DELETE", "/api/bots/editor", {});
    expect(store.state.groups[0]?.botIds).toEqual(["writer"]);
    expect((await request("DELETE", `/api/groups/${group.id}`, {})).status).toBe(200);
    expect(store.state.groups).toEqual([]);
    expect(runtime.list().some((run) => run.groupId === group.id)).toBe(false);
  });

  it("connects an API key without ever returning it", async () => {
    const { request, dataDir } = await server();
    expect(
      (
        await request("POST", "/api/bots/publisher/credentials", {
          type: "variable",
          name: "YT_KEY",
          value: "super-secret",
        })
      ).status,
    ).toBe(201);
    expect(
      (await request("POST", "/api/models/connect", { provider: "openai", apiKey: "sk-secret-123", model: "gpt-4.1" }))
        .status,
    ).toBe(201);
    const body = await (await request("GET", "/api/state")).text();
    expect(body).not.toContain("super-secret");
    expect(body).not.toContain("sk-secret-123");
    expect(readFileSync(join(dataDir, "accounts", `${OWNER}.json`), "utf8")).not.toContain("sk-secret-123");
    const state = JSON.parse(body) as AppState;
    expect(state.models.connections).toMatchObject([{ provider: "openai", label: "OpenAI", auth: "api_key" }]);
    expect(state.models.active).toEqual({ providerId: "openai", model: "gpt-4.1" });
    expect(state.bots.find((bot) => bot.id === "publisher")?.credentials[0]).toMatchObject({
      type: "variable",
      target: "YT_KEY",
    });
    expect(
      (await request("POST", "/api/models/connect", { provider: "openai-codex", apiKey: "sk-secret-123" })).status,
    ).toBe(422);
  });

  it("signs in with a subscription through a device code, then uses that model", async () => {
    const { request, signIn, store, accounts } = await server();
    expect((await request("POST", "/api/models/sign-in", { provider: "openai" })).status).toBe(422);
    const begin = await request("POST", "/api/models/sign-in", { provider: "openai-codex", model: "gpt-6.1-sol" });
    expect(begin.status).toBe(201);
    const started: SignInBegin = await begin.json();
    expect(started).toMatchObject({
      mode: "device-code",
      userCode: "ABCD-1234",
      verificationUri: "https://example.test/device",
    });
    const status = async () =>
      (await (await request("GET", `/api/models/sign-in/${started.loginId}`)).json()) as SignInStatus;
    expect(await status()).toEqual({ status: "pending" });
    signIn.finish();
    // The page polls until the sign-in reports connected; by then the space uses the new model.
    let last = await status();
    for (let tries = 0; last.status === "pending" && tries < 200; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      last = await status();
    }
    expect(last).toEqual({ status: "connected" });
    expect(store.state.active).toEqual({ providerId: "openai-codex", model: "gpt-6.1-sol" });
    expect(accounts.get(OWNER).connections).toMatchObject([
      { provider: "openai-codex", label: "ChatGPT", auth: "oauth" },
    ]);
    expect(JSON.stringify(accounts.get(OWNER))).not.toContain("access-token");
    expect(await accounts.credentials(OWNER).read("openai-codex")).toMatchObject({
      type: "oauth",
      access: "access-token",
    });
  });

  it("cancels a sign-in that is still waiting", async () => {
    const { request, accounts } = await server();
    const started: SignInBegin = await (
      await request("POST", "/api/models/sign-in", { provider: "github-copilot" })
    ).json();
    expect((await request("DELETE", `/api/models/sign-in/${started.loginId}`, {})).status).toBe(200);
    expect(await (await request("GET", `/api/models/sign-in/${started.loginId}`)).json()).toMatchObject({
      status: "error",
    });
    expect(accounts.get(OWNER).connections).toEqual([]);
  });

  it("disconnecting a provider removes it everywhere it was chosen", async () => {
    const { request, store, accounts } = await server();
    await request("POST", "/api/models/connect", { provider: "openai", apiKey: "sk-secret-123", model: "gpt-4.1" });
    await request("PUT", "/api/bots/scout", { model: { providerId: "openai", model: "gpt-4.1" } });
    await request("PUT", "/api/models/backups", { backups: [{ providerId: "openai", model: "gpt-4.1" }] });
    expect(store.state.backups).toHaveLength(1);
    expect((await request("DELETE", "/api/models/connections/openai", {})).status).toBe(200);
    expect(store.state).toMatchObject({ active: null, backups: [] });
    expect(store.state.bots.scout?.model).toBeNull();
    expect(accounts.get(OWNER).connections).toEqual([]);
    expect(await accounts.credentials(OWNER).read("openai")).toBeUndefined();
    expect(
      (await request("PUT", "/api/models/active", { choice: { providerId: "openai", model: "gpt-4.1" } })).status,
    ).toBe(404);
  });

  it("manages approval rules, memory, open work and conversations", async () => {
    const { request, store } = await server();
    await request("POST", "/api/approval-rules", {
      target: { kind: "category", category: "publish" },
      action: "require_approval",
    });
    await request("POST", "/api/approval-rules", {
      target: { kind: "category", category: "publish" },
      action: "require_approval",
    });
    expect(store.state.approvalRules).toHaveLength(1);
    await request("PUT", "/api/bots/scout/memory", { text: "Our best day is Tuesday." });
    expect(store.state.bots.scout?.memory).toMatchObject({ text: "Our best day is Tuesday.", revision: 1 });
    await request("POST", "/api/bots/scout/open-work", { text: "Check analytics" });
    const item = store.state.bots.scout?.openWork[0];
    await request("PATCH", `/api/bots/scout/open-work/${item?.id}`, { parked: true });
    expect(store.state.bots.scout?.openWork[0]?.parked).toBe(true);
    await request("POST", "/api/bots/scout/clear", {});
    expect(store.state.bots.scout?.historyClearedAt).not.toBeNull();
    const manifest = await (await request("GET", "/api/bots/scout/export")).json();
    expect(manifest).toMatchObject({
      kind: "savin-social/bot",
      bot: { id: "scout", memory: { text: "Our best day is Tuesday." } },
    });
    expect(manifest.bot).not.toHaveProperty("credentials");
  });

  it("saves preferences and the Google client to the account", async () => {
    const { request, accounts } = await server();
    await request("PUT", "/api/preferences", { theme: "dark" });
    await request("PUT", "/api/google", { clientId: "client-id", clientSecret: "client-secret" });
    expect(accounts.get(OWNER).preferences.theme).toBe("dark");
    expect(accounts.get(OWNER).google.clientId).toBe("client-id");
    expect(accounts.get(OWNER).google.clientSecret).not.toContain("client-secret");
  });

  it("validates routines and runs them on demand without overlap", async () => {
    const { request, runtime } = await server();
    expect(
      (
        await request("POST", "/api/routines", {
          name: "x",
          botId: "scout",
          instruction: "t",
          schedule: "every day",
          active: true,
          model: null,
        })
      ).status,
    ).toBe(400);
    const { id } = await (
      await request("POST", "/api/routines", {
        name: "Hourly",
        botId: "publisher",
        instruction: "t",
        schedule: "0 * * * *",
        active: false,
        model: null,
      })
    ).json();
    const first = await request("POST", `/api/routines/${id}/run`, {});
    expect(first.status).toBe(201);
    const run: Run = await first.json();
    expect(run.trigger).toEqual({ kind: "routine", routineId: id, name: "Hourly" });
    expect((await request("POST", `/api/routines/${id}/run`, {})).status).toBe(409);
    runtime.cancel(run.id);
  });

  it("starts runs and takes approval decisions", async () => {
    const { request, runtime } = await server();
    const run: Run = await (await request("POST", "/api/runs", { botId: "publisher", task: "post" })).json();
    await until(() => runtime.get(run.id)?.status === "waiting");
    const step = runtime.get(run.id)?.steps[0];
    expect((await request("POST", `/api/runs/${run.id}/steps/nope/decision`, { decision: "allow" })).status).toBe(404);
    expect(
      (await request("POST", `/api/runs/${run.id}/steps/${step?.id}/decision`, { decision: "allow" })).status,
    ).toBe(200);
    await runtime.wait(run.id);
    expect(runtime.get(run.id)?.status).toBe("succeeded");
  });

  it("gives and takes back control of a bot's computer", async () => {
    const { request } = await server();
    expect(await (await request("POST", "/api/computer/scout/control", { take: true })).json()).toMatchObject({
      scout: { holder: "you" },
    });
    expect(await (await request("POST", "/api/computer/scout/control", { take: false })).json()).toEqual({});
  });

  it("serves workspace files and streams uploads", async () => {
    const { request } = await server();
    const upload = await request("PUT", "/api/files/upload?path=inbox/note.txt", undefined, {
      "x-savin-upload": "1",
      "content-type": "text/plain",
    });
    expect(upload.status).toBe(400);
    await request("PUT", "/api/files/text", { path: "posts/a.md", content: "# Hi" });
    expect(await (await request("GET", "/api/files?path=posts")).json()).toMatchObject([
      { name: "a.md", type: "file" },
    ]);
    const raw = await request("GET", "/api/files/raw?path=posts/a.md");
    expect(raw.headers.get("content-security-policy")).toBe("sandbox");
    expect(await raw.text()).toBe("# Hi");
    expect((await request("GET", "/api/files/raw?path=../secret")).status).toBe(400);
  });

  it("opens the bot browser on the profile's platforms", async () => {
    const { request, opened } = await server();
    await request("POST", "/api/browser/open", {});
    expect(opened).toEqual([["https://studio.youtube.com"]]);
  });

  it("adds, renames, limits and removes browsers; the main one stays", async () => {
    const { request, opened, store } = await server();
    const added = await request("POST", "/api/browsers", {});
    expect(added.status).toBe(201);
    const { id, tab } = await added.json();
    expect(tab).toBe(`${id}.you`);
    expect(opened.at(-1)).toEqual([GEMINI_SIGN_IN]);
    expect(store.state.browsers.map((browser) => browser.name)).toEqual(["Main", "Browser 2"]);

    await request("PATCH", `/api/browsers/${id}`, { name: "Gemini two", videoLimit: 4 });
    await store.update((state) => ({
      ...state,
      browsers: state.browsers.map((browser) =>
        browser.id === id ? { ...browser, videos: { ...browser.videos, made: 4, stopped: "Limit reached" } } : browser,
      ),
    }));
    await request("PATCH", `/api/browsers/${id}`, { reset: true });
    expect(store.state.browsers[1]).toMatchObject({
      name: "Gemini two",
      videoLimit: 4,
      videos: { made: 0, stopped: null },
    });
    expect((await request("PATCH", `/api/browsers/${id}`, { videoLimit: 99 })).status).toBe(400);

    expect((await request("DELETE", "/api/browsers/main", {})).status).toBe(400);
    expect((await request("DELETE", `/api/browsers/${id}`, {})).status).toBe(200);
    expect(store.state.browsers.map((browser) => browser.id)).toEqual(["main"]);
    expect((await request("POST", `/api/browsers/${id}/open`, {})).status).toBe(404);
  });

  it("adds, marks, pauses and removes habits", async () => {
    const { request, store } = await server();
    expect((await request("POST", "/api/habits", { title: "" })).status).toBe(400);
    const added = await request("POST", "/api/habits", { title: "Post on LinkedIn", cadence: "weekly", target: 2 });
    const { id } = await added.json();
    expect(store.state.habits).toEqual([
      expect.objectContaining({ id, title: "Post on LinkedIn", why: "", cadence: "weekly", target: 2, done: [] }),
    ]);

    await request("PUT", `/api/habits/${id}/days/2026-10-23`, { done: true });
    await request("PUT", `/api/habits/${id}/days/2026-10-22`, { done: true });
    await request("PUT", `/api/habits/${id}/days/2026-10-23`, { done: false });
    expect(store.state.habits[0]?.done).toEqual(["2026-10-22"]);
    expect((await request("PUT", `/api/habits/${id}/days/yesterday`, { done: true })).status).toBe(400);
    expect((await request("PUT", "/api/habits/nope/days/2026-10-23", { done: true })).status).toBe(404);

    await request("PATCH", `/api/habits/${id}`, { why: "Be seen", active: false });
    expect(store.state.habits[0]).toMatchObject({
      title: "Post on LinkedIn",
      why: "Be seen",
      target: 2,
      active: false,
    });
    expect((await request("PATCH", "/api/habits/nope", { active: true })).status).toBe(404);

    for (let index = 0; index < 7; index++) {
      await request("POST", "/api/habits", { title: `Habit ${index}`, cadence: "daily" });
    }
    expect((await request("POST", "/api/habits", { title: "One more", cadence: "daily" })).status).toBe(400);
    expect((await request("PATCH", `/api/habits/${id}`, { active: true })).status).toBe(400);

    await request("DELETE", `/api/habits/${id}`, {});
    expect(store.state.habits.map((habit) => habit.title)).not.toContain("Post on LinkedIn");
  });

  it("writes out a recording sent as it is, in the account's language and with the space's names", async () => {
    const { app, request, voice } = await server();
    const record = (
      body: Uint8Array<ArrayBuffer> | string,
      headers: Record<string, string> = { "x-savin-upload": "1" },
    ) =>
      app.request("/api/voice/transcribe", {
        method: "POST",
        headers: { host: "127.0.0.1:4310", "content-type": "audio/webm", ...headers },
        body,
      });
    expect((await (await request("GET", "/api/voice")).json()).state).toBe("missing");
    // Another site's form cannot post a recording here: it has no way to add the custom header.
    expect((await record(webmRecording, {})).status).toBe(415);
    expect((await record(new Uint8Array())).status).toBe(400);
    expect((await record("<html>")).status).toBe(415);

    expect((await request("PUT", "/api/preferences", { dictation: "xx" })).status).toBe(400);
    await request("PUT", "/api/preferences", { dictation: "hi" });
    const response = await record(webmRecording);
    expect(await response.json()).toEqual({ text: "Coordinator, find ten React jobs in Pune." });
    const whisper = voice.runs.at(-1)?.args ?? [];
    expect(whisper).toEqual(expect.arrayContaining(["-l", "hi"]));
    expect(whisper.at(-1)).toMatch(
      /^Okay, so I asked the Director, the Scout, .* about My Channel, YouTube and Gemini\.$/,
    );
    expect((await (await request("POST", "/api/voice/prepare", {})).json()).state).toBe("ready");

    const tooLong = await record(new Uint8Array(16 * 1024 * 1024 + 1));
    expect(tooLong.status).toBe(413);
    expect((await tooLong.json()).error).toMatch(/under five minutes/);
  });

  it("refuses a body too big to be a typed message", async () => {
    const { request } = await server();
    const response = await request("POST", "/api/runs", { botId: "director", task: "x".repeat(1_100_000) });
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/Attach it as a file/);
  });

  it("forgets the upload channel only when asked", async () => {
    const { request, store } = await server();
    await store.update((state) => ({ ...state, channel: { id: "UCbrew", title: "Brew Lab" } }));
    expect((await (await request("GET", "/api/state")).json()).channel).toEqual({ id: "UCbrew", title: "Brew Lab" });
    await request("DELETE", "/api/channel", {});
    expect(store.state.channel).toBeNull();
  });
});
