import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Application,
  ApprovalRule,
  Avatar,
  BotCreate,
  BotId,
  Candidate,
  Channel,
  ComputerAccess,
  CredentialType,
  Group,
  Habit,
  ModelChoice,
  OpenWorkItem,
  Profile,
  Routine,
  Run,
  SpaceKind,
  Thinking,
  ToolGroups,
  Usage,
} from "../shared/contracts.ts";
import { MAIN_BROWSER } from "../shared/ids.ts";
import type { BotSeed } from "../shared/roster.ts";
import { botColors, defaultCandidate, defaultProfile, roleFor, rosterFor } from "../shared/roster.ts";
import type { Secrets } from "./secrets.ts";

export type BotRecord = {
  /** The team role whose instructions it follows by default, or null for a bot you created. */
  role: string | null;
  supervisor: BotId | null;
  createdAt: string;
  name: string;
  title: string;
  description: string;
  avatar: Avatar;
  notifications: boolean;
  computerAccess: ComputerAccess;
  tools: ToolGroups;
  delegation: boolean;
  /** null follows the automatic setup from the brand profile. */
  instructions: string | null;
  instructionHistory: { at: string; reason: string; text: string }[];
  model: ModelChoice | null;
  thinking: Thinking | null;
  memory: { text: string; revision: number; updatedAt: string | null };
  openWork: OpenWorkItem[];
  disabledTools: string[];
  credentials: { id: string; type: CredentialType; target: string; detail: string; secret: string }[];
  readAloud: boolean;
  voice: string | null;
  historyClearedAt: string | null;
  /** In a job search space: sends applications without asking, up to the day's limit. Off when missing. */
  autoApply?: boolean;
};

export type ConnectionRecord = {
  id: string;
  connectorId: string;
  label: string;
  account: string | null;
  status: "pending" | "connected" | "error" | "reconnect";
  error: string | null;
  createdAt: string;
  agents: BotId[];
  /** Sealed credential fields (tokens, keys, OAuth grants). */
  secret: string;
  activity: { at: string; tool: string; ok: boolean; detail: string | null }[];
  /** A Google sign-in in progress, kept here so a restart cannot lose it; the verifier is sealed. */
  pending?: { state: string; verifier: string; expires: number } | null;
};

export type McpServerRecord = {
  id: string;
  name: string;
  slug: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  headerName: string | null;
  /** Sealed { headerValue?, env? }. */
  secret: string | null;
  envKeys: string[];
  agents: BotId[];
};

/** One of a space's browsers; each extra one is its own Chromium profile with its own sign-ins. */
export type BrowserRecord = {
  id: string;
  name: string;
  createdAt: string;
  /** Gemini videos it makes a day before the next browser takes over. */
  videoLimit: number;
  /** Today's Gemini videos (by local date), and why Gemini stopped making them, if it did. */
  videos: { day: string; made: number; stopped: string | null };
};

/** One space: its brand, bots, routines, apps and the model it runs on. */
export type StoredState = {
  version: 5;
  kind: SpaceKind;
  profile: Profile;
  /** A job search space's profile of the person it applies for. */
  candidate: Candidate;
  applications: Application[];
  /** What the person of a job search space practises, with the Coordinator as coach. */
  habits: Habit[];
  bots: Record<BotId, BotRecord>;
  groups: Group[];
  routines: Routine[];
  active: ModelChoice | null;
  thinking: Thinking | null;
  backups: ModelChoice[];
  connections: ConnectionRecord[];
  mcpServers: McpServerRecord[];
  approvalRules: ApprovalRule[];
  usage: Usage;
  /** The main browser first, then the ones added for more Google accounts. */
  browsers: BrowserRecord[];
  channel: Channel | null;
};

const now = () => new Date().toISOString();

/** Gemini's video limits are daily, so counts start over each local day. */
export const today = () => new Date().toLocaleDateString("en-CA");

export function newBrowser(id: string, name: string): BrowserRecord {
  return { id, name, createdAt: now(), videoLimit: 3, videos: { day: today(), made: 0, stopped: null } };
}

/** Today's videos of a browser; yesterday's count no longer applies. */
export const videosToday = (browser: BrowserRecord) =>
  browser.videos.day === today() ? browser.videos : { day: today(), made: 0, stopped: null };

function blankBot(): Omit<BotRecord, "role" | "supervisor" | "name" | "title" | "description" | "avatar"> {
  return {
    createdAt: now(),
    notifications: true,
    computerAccess: "full",
    tools: { screen: false, browser: true, files: true, shell: true, video: false },
    delegation: false,
    instructions: null,
    instructionHistory: [],
    model: null,
    thinking: null,
    memory: { text: "", revision: 0, updatedAt: null },
    openWork: [],
    disabledTools: [],
    credentials: [],
    readAloud: false,
    voice: null,
    historyClearedAt: null,
  };
}

export function teamBot(seed: BotSeed): BotRecord {
  return {
    ...blankBot(),
    role: seed.id,
    supervisor: seed.supervisor,
    name: seed.name,
    title: seed.title,
    description: seed.description,
    avatar: seed.avatar,
    computerAccess: seed.computerAccess,
    tools: seed.tools,
    delegation: seed.delegation,
  };
}

/** savin's "New bot": the description becomes its instructions, and it gets the shared computer. */
export function createdBot(input: BotCreate, existing: number): BotRecord {
  return {
    ...blankBot(),
    role: null,
    supervisor: null,
    name: input.name,
    title: input.title,
    description: input.description,
    avatar: { icon: "bot", color: botColors[existing % botColors.length] ?? "#4f46e5", shape: "circle", image: null },
    instructions: input.description || `Help with ${input.title || input.name}.`,
  };
}

/** A space that no longer chooses a disconnected model provider anywhere. */
export function withoutProvider(state: StoredState, provider: string): StoredState {
  const keep = (choice: ModelChoice | null) => (choice?.providerId === provider ? null : choice);
  return {
    ...state,
    active: keep(state.active),
    backups: state.backups.filter((choice) => choice.providerId !== provider),
    bots: Object.fromEntries(
      Object.entries(state.bots).map(([id, record]) => [id, { ...record, model: keep(record.model) }]),
    ),
    routines: state.routines.map((routine) => ({ ...routine, model: keep(routine.model) })),
  };
}

/** The space's team (social media, or job search): every role it does not have yet. */
export const missingTeam = (bots: Record<BotId, BotRecord>, kind: SpaceKind = "social") =>
  Object.fromEntries(
    rosterFor(kind)
      .filter((seed) => !bots[seed.id])
      .map((seed) => [seed.id, teamBot(seed)]),
  );

const seedRoutines = (): Routine[] => [
  {
    id: randomUUID(),
    name: "Morning trend scan",
    botId: "scout",
    instruction: "Find today's 5 strongest content ideas for our niche and save them to research/ideas-<date>.md.",
    schedule: "0 9 * * *",
    active: false,
    model: null,
    lastRunAt: null,
  },
  {
    id: randomUUID(),
    name: "Weekly content batch",
    botId: "director",
    instruction: "Plan this week's posts, then have the team research, write, edit and upload them as drafts.",
    schedule: "0 10 * * 1",
    active: false,
    model: null,
    lastRunAt: null,
  },
  {
    id: randomUUID(),
    name: "Reply to comments",
    botId: "community",
    instruction: "Reply to new comments from the last 6 hours.",
    schedule: "0 */6 * * *",
    active: false,
    model: null,
    lastRunAt: null,
  },
];

/** The Coordinator's coaching rhythm: a short check-in each morning and a review each week. */
const coachRoutines = (): Routine[] => [
  {
    id: randomUUID(),
    name: "Morning check-in",
    botId: "coordinator",
    instruction:
      "Morning check-in: in a few lines, say how my habits and applications are going, name today's one focus, and ask me the single most useful question you still have about me.",
    schedule: "0 9 * * *",
    active: true,
    model: null,
    lastRunAt: null,
  },
  {
    id: randomUUID(),
    name: "Weekly review",
    botId: "coordinator",
    instruction:
      "Weekly review: look at this week's applications, replies, habits and my profile. Tell me what worked, what to change, and propose next week's plan with at most three habits.",
    schedule: "0 18 * * 0",
    active: true,
    model: null,
    lastRunAt: null,
  },
];

/** The job search team's routines; the daily search stays paused until the person has filled in the profile. */
const jobRoutines = (): Routine[] => [
  {
    id: randomUUID(),
    name: "Daily job search",
    botId: "coordinator",
    instruction: "Find today's best matching jobs, prepare the applications and apply, up to the daily limit.",
    schedule: "0 10 * * *",
    active: false,
    model: null,
    lastRunAt: null,
  },
  ...coachRoutines(),
];

export function freshState(team: boolean, kind: SpaceKind = "social"): StoredState {
  return {
    version: 5,
    kind,
    profile: defaultProfile,
    candidate: defaultCandidate,
    applications: [],
    habits: [],
    bots: team ? missingTeam({}, kind) : {},
    groups: [],
    routines: team ? (kind === "jobs" ? jobRoutines() : seedRoutines()) : [],
    active: null,
    thinking: null,
    backups: [],
    connections: [],
    mcpServers: [],
    approvalRules: [],
    usage: { runs: 0, inputTokens: 0, outputTokens: 0 },
    browsers: [newBrowser(MAIN_BROWSER, "Main")],
    channel: null,
  };
}

/** A version 4 state file: no habits, and a job search Coordinator that only plans. */
type V4State = Omit<StoredState, "version" | "habits"> & { version: 4 };

/** A version 3 state file: no Video tools, no Producer and a single browser. */
type V3State = Omit<V4State, "version" | "browsers" | "channel"> & { version: 3 };

/** A version 2 state file: one fixed team, with models, appearance and Google sign-in stored alongside. */
type V2State = Omit<StoredState, "version" | "bots"> & {
  version: 2;
  bots: Record<string, Omit<BotRecord, "role" | "supervisor" | "createdAt">>;
};

/** Brings a version 2 space forward; the team's bots keep their role as id. */
function migrate(old: V2State): V3State {
  const bots: Record<BotId, BotRecord> = {};
  for (const [id, record] of Object.entries(old.bots)) {
    const seed = roleFor(id);
    bots[id] = { ...record, role: seed ? id : null, supervisor: seed?.supervisor ?? null, createdAt: now() };
  }
  return {
    ...freshState(false),
    version: 3,
    profile: old.profile,
    bots,
    routines: old.routines,
    active: null,
    thinking: old.thinking ?? null,
    backups: [],
    connections: old.connections,
    mcpServers: old.mcpServers,
    approvalRules: old.approvalRules,
    usage: old.usage,
  };
}

/** Version 4: every bot gets the Video switch (off), and a space with the team gets the Producer. */
function addVideo(old: V3State): V4State {
  const bots: Record<BotId, BotRecord> = {};
  for (const [id, record] of Object.entries(old.bots))
    bots[id] = { ...record, tools: { ...record.tools, video: false } };
  const producer = roleFor("producer");
  if (producer && !bots[producer.id] && Object.values(bots).some((record) => record.role !== null)) {
    bots[producer.id] = teamBot(producer);
  }
  return { ...freshState(false), ...old, version: 4, bots };
}

/**
 * Version 5: habits, and a job search Coordinator that coaches. It gets the browser (which opens job
 * sites only) to read the person's own profiles, and the morning check-in and weekly review.
 */
function addCoaching(old: V4State): StoredState {
  const state: StoredState = { ...old, version: 5, habits: [] };
  const coordinator = state.bots.coordinator;
  if (state.kind !== "jobs" || coordinator?.role !== "coordinator") return state;
  return {
    ...state,
    bots: { ...state.bots, coordinator: { ...coordinator, tools: { ...coordinator.tools, browser: true } } },
    routines: [...state.routines, ...coachRoutines()],
  };
}

/** Runs saved by older versions are filled in so the thread view can show them. */
function normalizeRun(run: Run): Run {
  const trigger = run.trigger as Run["trigger"] | { kind: "automation"; automationId: string };
  return {
    ...run,
    attachments: run.attachments ?? [],
    usage: run.usage ?? { inputTokens: 0, outputTokens: 0 },
    trigger:
      trigger.kind === "automation" ? { kind: "routine", routineId: trigger.automationId, name: "Routine" } : trigger,
    steps: run.steps.map((step) => {
      if (step.kind !== "tool") return step;
      const skill = (step as { skill?: string }).skill;
      return {
        ...step,
        group: step.group ?? (skill === "terminal" ? "shell" : (skill ?? "shell")),
        gate: step.gate ?? null,
      };
    }),
  };
}

export async function writeJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, path);
}

/** JSON-file persistence for one space: a state file plus one file per run. */
export class Store {
  readonly runsDir: string;
  readonly workspaceDir: string;
  readonly browserProfileDir: string;
  /** Profiles of the browsers added after the main one. */
  readonly browsersDir: string;
  readonly skillsDir: string;
  private writes = Promise.resolve();
  private pendingRuns = new Map<string, { run: Run; timer: NodeJS.Timeout }>();

  private constructor(
    readonly dataDir: string,
    readonly secrets: Secrets,
    private current: StoredState,
  ) {
    this.runsDir = join(dataDir, "runs");
    this.workspaceDir = join(dataDir, "workspace");
    this.browserProfileDir = join(dataDir, "browser-profile");
    this.browsersDir = join(dataDir, "browsers");
    this.skillsDir = join(dataDir, "skills");
  }

  /** Opens a space's folder; a new one starts with its kind's team unless `team` is false. */
  static async open(dataDir: string, secrets: Secrets, options: { team?: boolean; kind?: SpaceKind } = {}) {
    for (const dir of ["runs", "workspace", "skills"]) await mkdir(join(dataDir, dir), { recursive: true });
    let stored: StoredState | V4State | V3State | V2State | null = null;
    try {
      stored = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
    } catch {}
    const state = !stored
      ? freshState(options.team ?? true, options.kind)
      : stored.version === 2
        ? addCoaching(addVideo(migrate(stored)))
        : stored.version === 3
          ? addCoaching(addVideo(stored))
          : stored.version === 4
            ? addCoaching(stored)
            : { ...freshState(false), ...stored };
    const store = new Store(dataDir, secrets, state);
    await store.update(() => state);
    return store;
  }

  get state(): StoredState {
    return this.current;
  }

  /** Where a browser keeps its profile: the main one where it always has, the others side by side. */
  browserDir(id: string) {
    return id === MAIN_BROWSER ? this.browserProfileDir : join(this.browsersDir, id);
  }

  update(change: (state: StoredState) => StoredState) {
    this.current = change(this.current);
    const snapshot = this.current;
    this.writes = this.writes.then(() => writeJson(join(this.dataDir, "state.json"), snapshot));
    return this.writes;
  }

  /** Changes one bot's record. */
  updateBot(id: BotId, change: (bot: BotRecord) => BotRecord) {
    return this.update((state) => {
      const bot = state.bots[id];
      return bot ? { ...state, bots: { ...state.bots, [id]: change(bot) } } : state;
    });
  }

  private writeRun(run: Run) {
    return writeJson(join(this.runsDir, `${run.id}.json`), run).catch(() => {});
  }

  /** Debounced so a busy run writes its file a few times a second at most. */
  saveRun(run: Run, immediately = false) {
    clearTimeout(this.pendingRuns.get(run.id)?.timer);
    this.pendingRuns.delete(run.id);
    if (immediately) {
      void this.writeRun(run);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingRuns.delete(run.id);
      void this.writeRun(run);
    }, 250);
    this.pendingRuns.set(run.id, { run, timer });
  }

  async deleteRuns(ids: string[]) {
    for (const id of ids) {
      clearTimeout(this.pendingRuns.get(id)?.timer);
      this.pendingRuns.delete(id);
      await rm(join(this.runsDir, `${id}.json`), { force: true });
    }
  }

  async loadRuns(limit = 500): Promise<Run[]> {
    const files = (await readdir(this.runsDir)).filter((name) => name.endsWith(".json"));
    const runs: Run[] = [];
    for (const file of files) {
      try {
        runs.push(normalizeRun(JSON.parse(await readFile(join(this.runsDir, file), "utf8"))));
      } catch {}
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  /** Writes everything still pending, before a space is closed. */
  async flush() {
    const pending = [...this.pendingRuns.values()];
    this.pendingRuns.clear();
    await Promise.all(
      pending.map(({ run, timer }) => {
        clearTimeout(timer);
        return this.writeRun(run);
      }),
    );
    await this.writes;
  }
}
