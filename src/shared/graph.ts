import type { AppState, BotId, PlatformId, Routine, Run, ToolGroup } from "./contracts.ts";
import { jobsLockedGroups, toolGroups } from "./ids.ts";
import { DEMO } from "./providers.ts";
import { platforms } from "./roster.ts";

/** The team map, derived from configuration plus live runs. */

export type BotActivity = {
  /** A run of this bot is in flight. */
  active: boolean;
  /** Waiting on the model rather than a tool. */
  thinking: boolean;
  /** Tool groups (or integrations) with a call running right now. */
  using: string[];
  /** Tool groups (or integrations) with a call waiting for a person. */
  gated: string[];
};

export type XY = { x: number; y: number };
export type TriggerData = {
  kind: "chat" | "routine" | "add";
  label: string;
  schedule?: string;
  active: boolean;
  live: boolean;
};
export type GraphNode =
  | { id: string; type: "trigger"; position: XY; data: TriggerData }
  | { id: string; type: "bot"; position: XY; data: { botId: BotId; activity: BotActivity } }
  | { id: string; type: "model"; position: XY; data: { label: string; detail: string; active: boolean } }
  | {
      id: string;
      type: "tool";
      position: XY;
      data: { group: ToolGroup; detail: string; available: boolean; active: boolean };
    }
  | {
      id: string;
      type: "app";
      position: XY;
      data: { kind: "connection" | "mcp"; refId: string; label: string; icon: string; status: string; active: boolean };
    }
  | { id: string; type: "platform"; position: XY; data: { platform: PlatformId; name: string; signedIn: boolean } };

export type EdgeKind = "trigger" | "delegation" | "tool" | "app" | "model" | "platform";
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  targetHandle?: string;
  kind: EdgeKind;
  /** The flow is live right now. */
  active: boolean;
  /** "ask" draws an approval gate on the edge; "off" dims it. */
  mode: "auto" | "ask" | "off";
  waiting: boolean;
};

const isLive = (run: Run) => run.status === "running" || run.status === "waiting";

export function botActivity(runs: Run[]): Map<BotId, BotActivity> {
  const activity = new Map<BotId, BotActivity>();
  for (const run of runs.filter(isLive)) {
    const entry = activity.get(run.botId) ?? { active: true, thinking: false, using: [], gated: [] };
    let busy = false;
    for (const step of run.steps) {
      if (step.kind !== "tool") continue;
      if (step.status === "running") {
        entry.using.push(step.group);
        busy = true;
      } else if (step.status === "approval") {
        entry.gated.push(step.group);
        busy = true;
      }
    }
    if (!busy && run.status === "running") entry.thinking = true;
    activity.set(run.botId, entry);
  }
  return activity;
}

const COLUMN = { trigger: 0, director: 290, workers: 620, tools: 970, apps: 1290 };
const ROW = 128;

export function buildGraph(state: AppState, runs: Run[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const live = runs.filter(isLive);
  const activity = botActivity(live);
  const idle: BotActivity = { active: false, thinking: false, using: [], gated: [] };
  const activityOf = (id: BotId) => activity.get(id) ?? idle;
  const anyUsing = (group: string) => [...activity.values()].some((entry) => entry.using.includes(group));

  // Bots nobody supervises lead (the Director, and bots you created); the rest work under them.
  const leads = state.bots.filter((bot) => bot.supervisor === null);
  const director = leads[0];
  const workers = state.bots.filter((bot) => bot.supervisor !== null);
  const middle = ((Math.max(workers.length, leads.length) - 1) * ROW) / 2;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edge = (e: Omit<GraphEdge, "id" | "mode" | "waiting"> & Partial<GraphEdge>) =>
    edges.push({ mode: "auto", waiting: false, id: `${e.source}->${e.target}`, ...e });

  // Triggers: chat messages plus every routine, centred on the Director.
  const triggers: { id: string; data: Omit<TriggerData, "live">; routine?: Routine }[] = [
    { id: "trigger:chat", data: { kind: "chat", label: "Chat", active: true } },
    ...state.routines.map((routine) => ({
      id: `trigger:${routine.id}`,
      data: { kind: "routine" as const, label: routine.name, schedule: routine.schedule, active: routine.active },
      routine,
    })),
    { id: "trigger:add", data: { kind: "add", label: "New routine", active: true } },
  ];
  const triggerTop = middle - ((triggers.length - 1) * 100) / 2;
  triggers.forEach((trigger, index) => {
    const { routine } = trigger;
    const isOn = routine
      ? live.some((run) => run.trigger.kind === "routine" && run.trigger.routineId === routine.id)
      : trigger.id === "trigger:chat" && live.some((run) => run.trigger.kind === "manual");
    nodes.push({
      id: trigger.id,
      type: "trigger",
      position: { x: COLUMN.trigger, y: triggerTop + index * 100 },
      data: { ...trigger.data, live: isOn },
    });
    if (routine) {
      edge({
        source: trigger.id,
        target: `bot:${routine.botId}`,
        kind: "trigger",
        active: isOn,
        mode: routine.active ? "auto" : "off",
      });
    }
  });
  // Chat goes to the Director by default, or to whichever bot someone is talking to.
  const chatTargets = new Set<BotId>(director ? [director.id] : []);
  for (const run of live) if (run.trigger.kind === "manual") chatTargets.add(run.botId);
  for (const botId of chatTargets) {
    edge({
      source: "trigger:chat",
      target: `bot:${botId}`,
      kind: "trigger",
      active: live.some((run) => run.trigger.kind === "manual" && run.botId === botId),
    });
  }

  // Bots: the leads supervise, the rest of the team works.
  const leadTop = middle - ((leads.length - 1) * ROW) / 2;
  leads.forEach((bot, index) => {
    nodes.push({
      id: `bot:${bot.id}`,
      type: "bot",
      position: { x: COLUMN.director, y: leadTop + index * ROW },
      data: { botId: bot.id, activity: activityOf(bot.id) },
    });
  });
  workers.forEach((bot, index) => {
    nodes.push({
      id: `bot:${bot.id}`,
      type: "bot",
      position: { x: COLUMN.workers, y: index * ROW },
      data: { botId: bot.id, activity: activityOf(bot.id) },
    });
  });

  // Delegation: the supervision tree, plus any live hand-off outside it.
  const handoffs = new Set(
    live.flatMap((run) =>
      run.trigger.kind === "delegation" || run.trigger.kind === "handoff"
        ? [`${run.trigger.fromBotId}>${run.botId}`]
        : [],
    ),
  );
  for (const bot of workers) {
    const supervisor = state.bots.find((other) => other.id === bot.supervisor);
    if (!supervisor) continue;
    handoffs.delete(`${supervisor.id}>${bot.id}`);
    edge({
      source: `bot:${supervisor.id}`,
      target: `bot:${bot.id}`,
      kind: "delegation",
      active: live.some(
        (run) => run.botId === bot.id && run.trigger.kind === "delegation" && run.trigger.fromBotId === supervisor.id,
      ),
      mode: supervisor.delegation ? "auto" : "off",
    });
  }
  for (const key of handoffs) {
    const [from, to] = key.split(">");
    edge({ source: `bot:${from}`, target: `bot:${to}`, kind: "delegation", active: true });
  }

  // One shared model behind every bot.
  const active = state.models.active;
  const connection = state.models.connections.find((candidate) => candidate.provider === active?.providerId);
  nodes.push({
    id: "model",
    type: "model",
    position: { x: COLUMN.director + 40, y: Math.max(middle, leadTop + (leads.length - 1) * ROW) + 220 },
    data: {
      label: active && active.providerId !== DEMO.providerId ? active.model : "Demo model",
      detail: connection?.label ?? "Offline",
      active: [...activity.values()].some((entry) => entry.thinking),
    },
  });
  for (const bot of state.bots) {
    edge({
      source: "model",
      target: `bot:${bot.id}`,
      targetHandle: "model",
      kind: "model",
      active: activityOf(bot.id).thinking,
    });
  }

  // The computer: savin's four tool groups, plus Gemini video across the space's browsers.
  const geminiBrowsers = state.browsers.filter((browser) => browser.google).length;
  const toolDetail: Record<ToolGroup, string> = {
    screen: state.environment.computer.driver,
    browser: state.environment.browser.headless ? "Chromium, headless" : "Chromium",
    files: "Shared workspace",
    shell: state.environment.shell,
    video: `Gemini · ${geminiBrowsers} ${geminiBrowsers === 1 ? "browser" : "browsers"}`,
  };
  // A job search space has no terminal, desktop or video, so the map leaves them out.
  const locked: readonly string[] = state.space.kind === "jobs" ? jobsLockedGroups : [];
  const shownGroups = toolGroups.filter((group) => !locked.includes(group));
  shownGroups.forEach((group, index) => {
    const id = `tool:${group}`;
    nodes.push({
      id,
      type: "tool",
      position: { x: COLUMN.tools, y: middle - (ROW * (shownGroups.length - 1)) / 2 + index * ROW },
      data: {
        group,
        detail: toolDetail[group],
        available: group !== "screen" || state.environment.computer.available,
        active: anyUsing(group),
      },
    });
    for (const bot of state.bots) {
      if (bot.computerAccess === "off" || !bot.tools[group]) continue;
      const entry = activityOf(bot.id);
      edge({
        source: `bot:${bot.id}`,
        target: id,
        kind: "tool",
        active: entry.using.includes(group),
        waiting: entry.gated.includes(group),
        mode: bot.computerAccess === "ask" ? "ask" : "auto",
      });
    }
  });

  // Apps and MCP servers the bots can reach, then the platforms the browser signs in to.
  const apps = [
    ...state.connections
      // An app counts once it has connected; one still signing in or failed lives in Integrations.
      .filter((connection) => connection.status === "connected" || connection.status === "reconnect")
      .map((connection) => ({
        id: `app:${connection.id}`,
        kind: "connection" as const,
        refId: connection.id,
        label: connection.label,
        icon: connection.connectorId,
        status: connection.status,
        agents: connection.agents,
        group: connection.label,
      })),
    ...state.mcpServers.map((server) => ({
      id: `app:${server.id}`,
      kind: "mcp" as const,
      refId: server.id,
      label: server.name,
      icon: "mcp",
      status: server.status,
      agents: server.agents,
      group: server.name,
    })),
  ];
  const right = [
    ...apps.map((app) => ({ kind: "app" as const, app })),
    ...(state.space.kind === "jobs" ? [] : state.profile.platforms).map((platform) => ({
      kind: "platform" as const,
      platform,
    })),
  ];
  const rightTop = middle - ((right.length - 1) * 76) / 2;
  right.forEach((entry, index) => {
    const position = { x: COLUMN.apps, y: rightTop + index * 76 };
    if (entry.kind === "platform") {
      const id = `platform:${entry.platform}`;
      nodes.push({
        id,
        type: "platform",
        position,
        data: {
          platform: entry.platform,
          name: platforms[entry.platform].name,
          signedIn: state.browserSignIns.includes(entry.platform),
        },
      });
      edge({ source: "tool:browser", target: id, kind: "platform", active: anyUsing("browser") });
      return;
    }
    const { app } = entry;
    nodes.push({
      id: app.id,
      type: "app",
      position,
      data: {
        kind: app.kind,
        refId: app.refId,
        label: app.label,
        icon: app.icon,
        status: app.status,
        active: anyUsing(app.group),
      },
    });
    for (const botId of app.agents) {
      const entryActivity = activityOf(botId);
      edge({
        source: `bot:${botId}`,
        target: app.id,
        kind: "app",
        active: entryActivity.using.includes(app.group),
        waiting: entryActivity.gated.includes(app.group),
      });
    }
  });

  return { nodes, edges };
}
