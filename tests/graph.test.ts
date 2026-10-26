import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../src/server/accounts.ts";
import { botViews } from "../src/server/bots.ts";
import { Secrets } from "../src/server/secrets.ts";
import { Store } from "../src/server/store.ts";
import type { AppState, Run } from "../src/shared/contracts.ts";
import { buildGraph } from "../src/shared/graph.ts";

async function appState(change: (state: AppState) => AppState = (state) => state): Promise<AppState> {
  const dir = mkdtempSync(join(tmpdir(), "savin-social-graph-"));
  const store = await Store.open(dir, Secrets.open(join(dir, "secret.key")));
  const base: AppState = {
    space: { id: "s1", name: "Personal", isDefault: true, kind: "social" },
    browserSignIns: [],
    browsers: [],
    channel: null,
    candidate: store.state.candidate,
    applications: [],
    habits: [],
    groups: [],
    profile: { ...store.state.profile, platforms: ["youtube", "instagram"] },
    bots: botViews(store.state),
    routines: [
      {
        id: "r1",
        name: "Daily",
        botId: "scout",
        instruction: "t",
        schedule: "0 9 * * *",
        active: true,
        model: null,
        lastRunAt: null,
      },
    ],
    models: { connections: [], active: null, thinking: null, backups: [] },
    connections: [
      {
        id: "c1",
        connectorId: "telegram",
        label: "Telegram",
        account: "@brew",
        status: "connected",
        error: null,
        createdAt: "",
        agents: ["community"],
        tools: [],
        activity: [],
      },
    ],
    mcpServers: [],
    approvalRules: [],
    preferences: defaultPreferences,
    google: { configured: false, clientId: null, redirectUri: "" },
    skills: [],
    usage: { runs: 0, inputTokens: 0, outputTokens: 0 },
    environment: {
      shell: "bash",
      workspaceDir: "/w",
      computer: { available: true, driver: "X11 desktop" },
      browser: { channel: "chromium", headless: false },
    },
  };
  return change(base);
}

const run = (overrides: Partial<Run>): Run => ({
  id: "r",
  botId: "director",
  task: "t",
  attachments: [],
  status: "running",
  trigger: { kind: "manual" },
  parentRunId: null,
  depth: 0,
  startedAt: new Date().toISOString(),
  endedAt: null,
  result: null,
  error: null,
  steps: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  ...overrides,
});

const edge = (graph: ReturnType<typeof buildGraph>, id: string) => graph.edges.find((candidate) => candidate.id === id);

describe("team map", () => {
  it("draws triggers, the team, the model, the four computer tools, apps and platforms", async () => {
    const graph = buildGraph(await appState(), []);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "trigger:chat",
      "trigger:r1",
      "trigger:add",
      "bot:director",
      "bot:scout",
      "bot:writer",
      "bot:editor",
      "bot:producer",
      "bot:publisher",
      "bot:community",
      "model",
      "tool:screen",
      "tool:browser",
      "tool:files",
      "tool:shell",
      "tool:video",
      "app:c1",
      "platform:youtube",
      "platform:instagram",
    ]);
    expect(graph.nodes.find((node) => node.id === "model")?.data).toMatchObject({
      label: "Demo model",
      detail: "Offline",
    });
  });

  it("shows supervision, access levels and which bots may use each app", async () => {
    const graph = buildGraph(await appState(), []);
    expect(
      graph.edges.filter((candidate) => candidate.kind === "delegation").map((candidate) => candidate.target),
    ).toEqual(["bot:scout", "bot:writer", "bot:editor", "bot:producer", "bot:publisher", "bot:community"]);
    expect(edge(graph, "bot:publisher->tool:browser")?.mode).toBe("ask");
    expect(edge(graph, "bot:scout->tool:browser")?.mode).toBe("auto");
    expect(edge(graph, "bot:writer->tool:browser")).toBeUndefined();
    expect(edge(graph, "bot:community->app:c1")).toBeDefined();
    expect(edge(graph, "bot:scout->app:c1")).toBeUndefined();
    expect(edge(graph, "trigger:r1->bot:scout")?.mode).toBe("auto");
  });

  it("lights up the path of live work and marks what waits for a person", async () => {
    const runs = [
      run({ id: "root" }),
      run({
        id: "child",
        botId: "community",
        parentRunId: "root",
        depth: 1,
        status: "waiting",
        trigger: { kind: "delegation", fromBotId: "director" },
        steps: [
          {
            kind: "tool",
            id: "s",
            at: "",
            group: "Telegram",
            tool: "telegram_send_message",
            input: {},
            status: "approval",
            gate: { kind: "approval", allowAlways: true, summary: "" },
          },
        ],
      }),
      run({
        id: "scout",
        botId: "scout",
        trigger: { kind: "delegation", fromBotId: "director" },
        steps: [
          {
            kind: "tool",
            id: "s2",
            at: "",
            group: "shell",
            tool: "terminal_run",
            input: {},
            status: "running",
            gate: null,
          },
        ],
      }),
    ];
    const graph = buildGraph(await appState(), runs);
    expect(edge(graph, "trigger:chat->bot:director")?.active).toBe(true);
    expect(edge(graph, "bot:director->bot:community")?.active).toBe(true);
    expect(edge(graph, "bot:community->app:c1")).toMatchObject({ waiting: true, active: false });
    expect(edge(graph, "bot:scout->tool:shell")?.active).toBe(true);
    expect(edge(graph, "model->bot:director")?.active).toBe(true);
    expect(graph.nodes.find((node) => node.id === "bot:community")?.data).toMatchObject({
      activity: { active: true, gated: ["Telegram"] },
    });
  });

  it("puts bots you created beside the Director and names the connected model", async () => {
    const state = await appState((current) => {
      const director = current.bots[0];
      if (!director) throw new Error("No director");
      return {
        ...current,
        bots: [...current.bots, { ...director, id: "bot-1", role: null, supervisor: null, name: "Analyst" }],
        models: {
          ...current.models,
          connections: [{ provider: "openai-codex", label: "ChatGPT", auth: "oauth", connectedAt: "", server: null }],
          active: { providerId: "openai-codex", model: "gpt-6.1-sol" },
        },
      };
    });
    const graph = buildGraph(state, []);
    const position = (id: string) => graph.nodes.find((node) => node.id === id)?.position;
    expect(position("bot:bot-1")?.x).toBe(position("bot:director")?.x);
    expect(edge(graph, "trigger:chat->bot:director")).toBeDefined();
    expect(edge(graph, "trigger:chat->bot:bot-1")).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === "model")?.data).toMatchObject({
      label: "gpt-6.1-sol",
      detail: "ChatGPT",
    });
  });

  it("dims what a bot without computer access or a paused routine would use", async () => {
    const state = await appState((current) => ({
      ...current,
      bots: current.bots.map((bot) => (bot.id === "publisher" ? { ...bot, computerAccess: "off" } : bot)),
      routines: current.routines.map((routine) => ({ ...routine, active: false })),
    }));
    const graph = buildGraph(state, []);
    expect(edge(graph, "bot:publisher->tool:browser")).toBeUndefined();
    expect(edge(graph, "trigger:r1->bot:scout")?.mode).toBe("off");
  });
});
