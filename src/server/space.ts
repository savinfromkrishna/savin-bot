import type { Hono } from "hono";
import type { WebSocket } from "ws";
import type { AppState, BotId, BrowserView, SpaceKind, SpaceSummary, SpaceView } from "../shared/contracts.ts";
import { MAIN_BROWSER, parseTabKey } from "../shared/ids.ts";
import type { Accounts } from "./accounts.ts";
import { botViews } from "./bots.ts";
import { EventBus } from "./events.ts";
import { createApp } from "./http.ts";
import { McpServers } from "./integrations/mcp.ts";
import { Integrations } from "./integrations/service.ts";
import { builtInSkillsDir, jobSkillsDir, SkillLibrary } from "./library.ts";
import { modelChain } from "./llm/models.ts";
import { saveMemory, updateOpenWork } from "./routes/bots.ts";
import { Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import type { Secrets } from "./secrets.ts";
import { Store, videosToday } from "./store.ts";
import { Browsers, browserTools } from "./tools/browser.ts";
import { coachTools } from "./tools/coach.ts";
import type { ComputerDriver } from "./tools/computer.ts";
import { computerTools } from "./tools/computer.ts";
import { filesTools } from "./tools/files.ts";
import { applicationTools, appliedToday, jobSiteAllowed } from "./tools/jobs.ts";
import { knowledgeTools } from "./tools/knowledge.ts";
import { postTools } from "./tools/posts.ts";
import { shell, shellName, terminalTools } from "./tools/terminal.ts";
import { videoTools } from "./tools/video.ts";
import { webTools } from "./tools/web.ts";
import { youtubeTools } from "./tools/youtube.ts";
import type { Voice } from "./voice.ts";
import { Workspace } from "./workspace/files.ts";
import { CommandLogs, Terminals } from "./workspace/terminals.ts";

export type SpaceRecord = SpaceView & { ownerId: string; createdAt: string };

/** What every space shares: the key, the accounts, this machine's screen and the server's address. */
export type SpaceShared = {
  secrets: Secrets;
  accounts: Accounts;
  computer: ComputerDriver;
  /** Where Google sends people back after signing in. */
  redirectUri: string;
  browser: { headless: boolean; channel?: string };
  /** Clears a disconnected model provider from every space of an account. */
  forgetProvider: (ownerId: string, provider: string) => Promise<void>;
  /** Voice typing: one speech model on this computer for every space. */
  voice: Voice;
};

export type OpenSpace = {
  readonly record: SpaceRecord;
  app: Hono;
  store: Store;
  runtime: Runtime;
  integrations: Integrations;
  announce: () => void;
  summary: () => SpaceSummary;
  socket: { terminal: (id: string, socket: WebSocket) => void; browser: (key: string, socket: WebSocket) => void };
  close: () => Promise<void>;
};

/** One space, wired up: its bots, computer, apps, routines and API. */
export async function openSpace(
  dir: string,
  record: () => SpaceRecord,
  shared: SpaceShared,
  options: { team?: boolean; kind?: SpaceKind } = {},
): Promise<OpenSpace> {
  const { secrets, accounts, computer } = shared;
  const ownerId = record().ownerId;
  const store = await Store.open(dir, secrets, options);
  const events = new EventBus();
  let announce = () => {};
  // A page load may have signed the browser in or out somewhere, so the view refreshes shortly after.
  let signInCheck: NodeJS.Timeout | undefined;
  // A job search space is locked down: its bots' browser and web tools reach job sites only, and it has
  // no terminal, desktop or video tools (the runtime refuses those groups there too).
  const jobs = store.state.kind === "jobs";
  const allowNavigation = jobs ? (url: string) => jobSiteAllowed(url, store.state.candidate.sites) : undefined;

  const browsers = new Browsers({
    allowNavigation,
    dir: (id) => store.browserDir(id),
    known: (id) => store.state.browsers.some((browser) => browser.id === id),
    headless: shared.browser.headless,
    channel: shared.browser.channel,
    onTabs: (tabs) => {
      events.emit({ type: "browser", tabs });
      clearTimeout(signInCheck);
      signInCheck = setTimeout(() => announce(), 1500);
    },
  });
  const browser = browsers.main;
  const channel = () => store.state.channel;
  const workspace = new Workspace(store.workspaceDir);
  const stopWatching = workspace.watch(() => events.emit({ type: "files" }));
  const terminals = new Terminals({ cwd: store.workspaceDir, shell, events });
  const commands = new CommandLogs(events);
  const skills = new SkillLibrary(store.skillsDir, jobs ? jobSkillsDir : builtInSkillsDir);
  const environment: AppState["environment"] = {
    shell: shellName,
    workspaceDir: store.workspaceDir,
    computer: { available: computer.available, driver: computer.name },
    browser: { channel: shared.browser.channel || "chromium", headless: shared.browser.headless },
  };

  const mcp = new McpServers({
    open: (server) => (server.secret ? secrets.open(server.secret) : {}),
    onChange: () => announce(),
    cwd: store.workspaceDir,
  });
  const integrations = new Integrations({
    store,
    mcp,
    redirectUri: shared.redirectUri,
    onChange: () => announce(),
    google: () => accounts.get(ownerId).google,
  });

  const runtime = new Runtime({
    store,
    events,
    environment,
    tools: [
      ...browserTools(browser, {
        channel,
        allowNavigation,
        confirmSubmit: jobs,
        autoApply: (botId) => {
          if (!jobs || !store.state.bots[botId]?.autoApply) return false;
          const { perDay } = store.state.candidate;
          return (
            appliedToday(store.state.applications) < perDay ||
            `${perDay} applications went out on their own today, the daily limit in Settings → Candidate. This one waits for you.`
          );
        },
      }),
      ...(jobs
        ? [
            ...applicationTools({
              list: () => store.state.applications,
              save: async (applications) => {
                await store.update((state) => ({ ...state, applications }));
                announce();
              },
            }),
            ...coachTools({
              candidate: () => store.state.candidate,
              saveCandidate: async (candidate) => {
                await store.update((state) => ({ ...state, candidate }));
                announce();
              },
              habits: () => store.state.habits,
              saveHabits: async (habits) => {
                await store.update((state) => ({ ...state, habits }));
                announce();
              },
            }),
          ]
        : [
            ...terminalTools(commands),
            ...youtubeTools({ browser, channel }),
            ...postTools(),
            ...computerTools(computer),
            ...videoTools({
              browsers,
              list: () => store.state.browsers,
              signedIn: async (id) => (await browsers.get(id).signIns()).google,
              record: async (id, change) => {
                await store.update((state) => ({
                  ...state,
                  browsers: state.browsers.map((record) => {
                    if (record.id !== id) return record;
                    const videos = videosToday(record);
                    return {
                      ...record,
                      videos:
                        "made" in change
                          ? { ...videos, made: videos.made + 1 }
                          : { ...videos, stopped: change.stopped },
                    };
                  }),
                }));
                announce();
              },
            }),
          ]),
      ...filesTools(),
      ...webTools({ allowUrl: allowNavigation }),
      ...knowledgeTools({
        saveMemory: async (id, text) => {
          await saveMemory(store, id, text);
          announce();
        },
        updateOpenWork: async (id, change) => {
          const items = await updateOpenWork(store, id, change);
          announce();
          return items;
        },
        skills,
      }),
    ],
    integrations,
    skills: () => skills.list(),
    activity: commands,
    announce: () => announce(),
    models: (override) => modelChain(accounts.access(ownerId), store.state, override),
    browserSignIns: () => browser.signedIn(),
  });
  await runtime.restore();

  const scheduler = new Scheduler(store, runtime, () => announce());
  scheduler.sync();
  scheduler.catchUp();

  const state = async (): Promise<AppState> => {
    const current = store.state;
    const account = accounts.get(ownerId);
    const { id, name, isDefault } = record();
    const views = await Promise.all(
      current.browsers.map(async (record): Promise<BrowserView> => {
        const signIns = await browsers.get(record.id).signIns();
        const videos = videosToday(record);
        return {
          id: record.id,
          name: record.name,
          main: record.id === MAIN_BROWSER,
          google: signIns.google,
          signedIn: signIns.platforms,
          videos: { made: videos.made, limit: record.videoLimit, stopped: videos.stopped },
        };
      }),
    );
    return {
      space: { id, name, isDefault, kind: current.kind },
      profile: current.profile,
      candidate: current.candidate,
      applications: current.applications,
      habits: current.habits,
      browserSignIns: views.find((view) => view.main)?.signedIn ?? [],
      browsers: views,
      channel: current.channel,
      bots: botViews(current),
      groups: current.groups,
      routines: current.routines,
      models: {
        connections: account.connections,
        active: current.active,
        thinking: current.thinking,
        backups: current.backups,
      },
      connections: integrations.views(),
      mcpServers: integrations.mcpViews(),
      approvalRules: current.approvalRules,
      preferences: account.preferences,
      google: {
        configured: Boolean(account.google.clientId && account.google.clientSecret),
        clientId: account.google.clientId,
        redirectUri: shared.redirectUri,
      },
      skills: await skills.list(),
      usage: current.usage,
      environment,
    };
  };

  const created = createApp({
    store,
    runtime,
    scheduler,
    events,
    integrations,
    skills,
    browsers,
    workspace: { workspace, terminals, commands },
    accounts,
    ownerId,
    forgetProvider: (provider) => shared.forgetProvider(ownerId, provider),
    state,
    voice: shared.voice,
  });
  announce = created.announce;
  mcp.sync(store.state.mcpServers);

  return {
    get record() {
      return record();
    },
    app: created.app,
    store,
    runtime,
    integrations,
    announce: () => announce(),
    summary: () => {
      const { id, name, isDefault } = record();
      return {
        id,
        name,
        isDefault,
        kind: store.state.kind,
        bots: botViews(store.state).map((bot) => ({
          id: bot.id,
          name: bot.name,
          title: bot.title,
          avatar: bot.avatar,
        })),
      };
    },
    socket: {
      terminal: (id, socket) => terminals.attach(id, socket),
      browser: (key, socket) => {
        // A person's own tabs take input; a bot's tab does once they hold that bot's computer.
        const tab = parseTabKey(key).key;
        return browsers.stream(
          key,
          socket,
          () => tab.startsWith("you") || Boolean(runtime.controlState()[tab as BotId]),
        );
      },
    },
    close: async () => {
      clearTimeout(signInCheck);
      scheduler.stop();
      stopWatching();
      terminals.closeAll();
      // Work in progress pauses rather than ends: the next start picks it up again.
      await runtime.suspend();
      await Promise.all([browsers.close(), mcp.closeAll()]);
      await store.flush();
    },
  };
}
