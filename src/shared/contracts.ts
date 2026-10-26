import { z } from "zod";
import {
  applicationStatuses,
  computerAccessLevels,
  type credentialTypes,
  type DictationLanguage,
  dictationLanguages,
  habitCadences,
  platformIds,
  ruleCategories,
  spaceKinds,
  thinkingLevels,
  type toolGroups,
} from "./ids.ts";

/** Team bots keep their role as id ("director"); bots you create get a generated one. */
export const BotId = z.string().regex(/^[a-z0-9-]{1,60}$/, "Unknown bot");
export type BotId = z.infer<typeof BotId>;
export const PlatformId = z.enum(platformIds);
export type PlatformId = z.infer<typeof PlatformId>;
export type ToolGroup = (typeof toolGroups)[number];
export type ToolGroups = Record<ToolGroup, boolean>;
export const ComputerAccess = z.enum(computerAccessLevels);
export type ComputerAccess = z.infer<typeof ComputerAccess>;
export const Thinking = z.enum(thinkingLevels);
export type Thinking = z.infer<typeof Thinking>;

// ---------- Brand profile: the source of every bot's automatic setup ----------

export const Profile = z.object({
  brand: z.string().trim().min(1).max(80),
  niche: z.string().trim().max(200),
  audience: z.string().trim().max(200),
  tone: z.string().trim().max(120),
  language: z.string().trim().min(1).max(40),
  platforms: z.array(PlatformId).min(1),
  postsPerWeek: z.number().int().min(0).max(50),
  publish: z.enum(["draft", "public"]),
});
export type Profile = z.infer<typeof Profile>;

// ---------- Candidate: a job search space's profile ----------

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a domain like api.example.com");

export const Candidate = z.object({
  name: z.string().trim().max(80),
  email: z.string().trim().max(120),
  phone: z.string().trim().max(40),
  location: z.string().trim().max(120),
  /** The roles, places and kind of work wanted. */
  goals: z.string().trim().max(1000),
  /** Experience, skills and highlights: everything the team may say about the person. */
  summary: z.string().trim().max(8000),
  links: z.string().trim().max(1000),
  /** Ready answers to common questions: notice period, salary, work authorization, relocation. */
  answers: z.string().trim().max(4000),
  /** Workspace path of the résumé to upload. */
  resume: z.string().trim().max(500),
  perDay: z.number().int().min(1).max(50),
  /** Sites the bots' browser may open besides job sites and careers pages. */
  sites: z.array(Domain).max(100),
});
export type Candidate = z.infer<typeof Candidate>;

export const ApplicationStatus = z.enum(applicationStatuses);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;
/** One job in the tracker, from found to applied and beyond. */
export type Application = {
  id: string;
  company: string;
  role: string;
  url: string;
  status: ApplicationStatus;
  note: string;
  updatedAt: string;
  appliedAt: string | null;
};

// ---------- Bots ----------

export const ModelChoice = z.object({
  providerId: z.string().min(1).max(80),
  model: z.string().trim().min(1).max(160),
});
export type ModelChoice = z.infer<typeof ModelChoice>;

export const Avatar = z.object({
  icon: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  shape: z.enum(["circle", "square"]),
  /** A small uploaded picture as a data URL; replaces the icon. */
  image: z.string().max(300_000).nullable(),
});
export type Avatar = z.infer<typeof Avatar>;

/** A credential as entered; secret parts are encrypted at rest and never reach the model. */
export const CredentialInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer"), domain: Domain, token: z.string().min(1).max(4000) }),
  z.object({
    type: z.literal("header"),
    domain: Domain,
    header: z.string().trim().min(1).max(100),
    value: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal("basic"),
    domain: Domain,
    username: z.string().min(1).max(200),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("login"),
    domain: Domain,
    username: z.string().min(1).max(200),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("variable"),
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Use CAPITALS_AND_UNDERSCORES"),
    value: z.string().min(1).max(8000),
  }),
]);
export type CredentialInput = z.infer<typeof CredentialInput>;
export type CredentialType = (typeof credentialTypes)[number];
export type CredentialView = { id: string; type: CredentialType; target: string; detail: string };

export type OpenWorkItem = { id: string; text: string; parked: boolean };

/** "New bot": everything else is set up automatically and can be changed in its settings. */
export const BotCreate = z.object({
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(500),
  description: z.string().trim().max(4000),
});
export type BotCreate = z.infer<typeof BotCreate>;

export const BotPatch = z
  .object({
    name: z.string().trim().min(1).max(80),
    title: z.string().trim().max(500),
    description: z.string().trim().max(4000),
    avatar: Avatar,
    notifications: z.boolean(),
    computerAccess: ComputerAccess,
    tools: z
      .object({ screen: z.boolean(), browser: z.boolean(), files: z.boolean(), shell: z.boolean(), video: z.boolean() })
      .partial(),
    delegation: z.boolean(),
    /** null returns the instructions to the automatic setup from the brand profile. */
    instructions: z.string().max(20_000).nullable(),
    model: ModelChoice.nullable(),
    thinking: Thinking.nullable(),
    disabledTools: z.array(z.string().trim().min(1).max(120)).max(200),
    readAloud: z.boolean(),
    voice: z.string().max(200).nullable(),
    autoApply: z.boolean(),
  })
  .partial();
export type BotPatch = z.infer<typeof BotPatch>;

export type Bot = {
  id: BotId;
  /** The team role whose instructions it follows by default ("director"), or null for a bot you created. */
  role: string | null;
  supervisor: BotId | null;
  name: string;
  title: string;
  description: string;
  avatar: Avatar;
  notifications: boolean;
  computerAccess: ComputerAccess;
  tools: ToolGroups;
  delegation: boolean;
  instructions: string;
  instructionsAutomatic: boolean;
  instructionHistory: { at: string; reason: string; text: string }[];
  model: ModelChoice | null;
  thinking: Thinking | null;
  memory: { text: string; revision: number; updatedAt: string | null };
  openWork: OpenWorkItem[];
  disabledTools: string[];
  credentials: CredentialView[];
  readAloud: boolean;
  voice: string | null;
  historyClearedAt: string | null;
  /** In a job search space: sends applications without asking, up to the day's limit. */
  autoApply: boolean;
};

// ---------- Groups ----------

/** savin's group chat: one shared thread with 2–10 bots. */
export const GroupInput = z.object({
  name: z.string().trim().min(1, "Name this group").max(80),
  /** In the order they were picked; the first answers when nobody is mentioned. */
  botIds: z.array(BotId).min(2, "Pick at least 2 bots").max(10, "Pick up to 10 bots"),
});
export type GroupInput = z.infer<typeof GroupInput>;
export type Group = GroupInput & { id: string; createdAt: string };

// ---------- Habits: what the person practises, with the Coordinator as coach ----------

export const HabitInput = z.object({
  title: z.string().trim().min(1).max(120),
  /** How it moves the person toward the job they want. */
  why: z.string().trim().max(300).default(""),
  cadence: z.enum(habitCadences),
  /** Times a week, for a weekly habit. */
  target: z.number().int().min(1).max(7).default(1),
});
export type HabitInput = z.infer<typeof HabitInput>;
/** A change to a habit: only the fields given, so nothing falls back to a default. */
export const HabitPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  why: z.string().trim().max(300).optional(),
  cadence: z.enum(habitCadences).optional(),
  target: z.number().int().min(1).max(7).optional(),
  active: z.boolean().optional(),
});
export type HabitPatch = z.infer<typeof HabitPatch>;
export type Habit = HabitInput & {
  id: string;
  createdAt: string;
  active: boolean;
  /** Local days (YYYY-MM-DD) it was done. */
  done: string[];
};
/** A local calendar day. */
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a day like 2026-10-23");

export const GroupMessageInput = z.object({
  text: z.string().trim().min(1).max(8000),
  attachments: z.array(z.string().max(1000)).max(20).default([]),
});

// ---------- Routines (schedules) ----------

export const RoutineInput = z.object({
  name: z.string().trim().min(1).max(80),
  botId: BotId,
  instruction: z.string().trim().min(1).max(4000),
  schedule: z.string().trim().min(1).max(100),
  active: z.boolean(),
  model: ModelChoice.nullable(),
});
export type RoutineInput = z.infer<typeof RoutineInput>;
export type Routine = RoutineInput & { id: string; lastRunAt: string | null };

// ---------- Models ----------

export type SignInMode = "device-code" | "auth-url";

/** A provider in Settings → Models: how it connects and the models it offers. */
export type ModelProviderView = {
  id: string;
  name: string;
  /** In-app subscription sign-in, when the provider has one. */
  signIn: { mode: SignInMode; label: string } | null;
  apiKey: boolean;
  hint: string;
  billing: string;
  /** A key can be checked by listing the provider's models. */
  keyTest: boolean;
  models: { id: string; label: string; thinking: Thinking[] }[];
};

/** A provider an account connected. Its key or tokens stay sealed on the server. */
export type ModelConnectionView = {
  provider: string;
  label: string;
  auth: "api_key" | "oauth" | "server";
  connectedAt: string;
  /** Your own OpenAI-compatible server and the models found on it. */
  server: { baseUrl: string; models: string[]; reasoning: boolean } | null;
};

/** The account's connections plus the model this space uses. */
export type ModelSettings = {
  connections: ModelConnectionView[];
  /** null means the built-in offline demo model. */
  active: ModelChoice | null;
  /** null uses each model's default effort. */
  thinking: Thinking | null;
  backups: ModelChoice[];
};

export const ModelConnectInput = z.object({
  provider: z.string().min(1).max(80),
  apiKey: z.string().trim().min(8, "API key must contain at least 8 characters").max(4000).optional(),
  /** OpenAI-compatible server only. */
  baseUrl: z.url().optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  reasoning: z.boolean().optional(),
  /** The model to use once connected. */
  model: z.string().trim().min(1).max(200).optional(),
  thinking: Thinking.nullable().optional(),
});
export type ModelConnectInput = z.infer<typeof ModelConnectInput>;

export type SignInBegin = { loginId: string; provider: string; verificationUri: string; expiresInSeconds: number } & (
  | { mode: "device-code"; userCode: string }
  | { mode: "auth-url" }
);
export type SignInStatus = { status: "pending" } | { status: "connected" } | { status: "error"; error: string };

// ---------- Spaces and accounts ----------

export const SpaceKind = z.enum(spaceKinds);
export type SpaceKind = z.infer<typeof SpaceKind>;
export const SpaceInput = z.object({
  name: z.string().trim().min(1, "Name the space").max(60),
  kind: SpaceKind.default("social"),
  /** Start with the space's team: the social media team, or the job search team. */
  team: z.boolean().default(true),
});
export type SpaceView = { id: string; name: string; isDefault: boolean };
/** A space in the sidebar, with its bots, so another space's bots are one click away. */
export type SpaceSummary = SpaceView & {
  kind: SpaceKind;
  bots: { id: BotId; name: string; title: string; avatar: Avatar }[];
};
export type Me = { user: { id: string; name: string; email: string }; spaces: SpaceSummary[] };

// ---------- Browsers ----------

/** Another browser for the space: its own Chromium profile, so one more Google account and its Gemini videos. */
export const BrowserInput = z
  .object({
    name: z.string().trim().min(1).max(40),
    /** Gemini videos it makes a day before the next browser takes over. */
    videoLimit: z.number().int().min(0).max(50),
    /** Forgets today's count and limit, after a wrong limit or an upgrade. */
    reset: z.literal(true),
  })
  .partial();
export type BrowserView = {
  id: string;
  name: string;
  main: boolean;
  /** Signed in to a Google account, which Gemini needs. */
  google: boolean;
  signedIn: PlatformId[];
  /** Today's Gemini videos, and why Gemini stopped making them here today. */
  videos: { made: number; limit: number; stopped: string | null };
};

/** The one YouTube channel the team uploads to, set once. */
export type Channel = { id: string; title: string };

// ---------- Integrations ----------

export type AuthField = {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  optional?: boolean;
  /** A fixed set of choices, shown as a select. */
  options?: string[];
};
export type ToolInfo = { name: string; description: string; readOnly: boolean };
export type CatalogItem = {
  id: string;
  name: string;
  description: string;
  category: "Social" | "Messaging" | "Media" | "Productivity" | "Developer";
  icon: string;
  featured: boolean;
  auth: { kind: "fields"; fields: AuthField[] } | { kind: "google"; scopes: string[] };
  tools: ToolInfo[];
  docsUrl: string | null;
};

export type ConnectionActivity = { at: string; tool: string; ok: boolean; detail: string | null };
export type ConnectionView = {
  id: string;
  connectorId: string;
  label: string;
  account: string | null;
  status: "pending" | "connected" | "error" | "reconnect";
  error: string | null;
  createdAt: string;
  agents: BotId[];
  tools: ToolInfo[];
  activity: ConnectionActivity[];
};

export const ConnectionInput = z.object({
  connectorId: z.string().min(1).max(60),
  label: z.string().trim().max(80).optional(),
  fields: z.record(z.string(), z.string().max(8000)),
  agents: z.array(BotId),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;

export const McpServerInput = z.object({
  name: z.string().trim().min(1).max(60),
  transport: z.enum(["http", "sse", "stdio"]),
  url: z.url().optional(),
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  headerName: z.string().trim().max(100).optional(),
  /** Absent keeps the saved value; an empty string removes it. */
  headerValue: z.string().max(8000).optional(),
  env: z.record(z.string(), z.string().max(8000)).optional(),
  agents: z.array(BotId),
});
export type McpServerInput = z.infer<typeof McpServerInput>;
export type McpServerView = {
  id: string;
  name: string;
  slug: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  headerName: string | null;
  hasSecret: boolean;
  envKeys: string[];
  agents: BotId[];
  status: "connected" | "connecting" | "error";
  error: string | null;
  tools: ToolInfo[];
};

// ---------- Approvals ----------

export const RuleCategory = z.enum(ruleCategories);
export type RuleCategory = z.infer<typeof RuleCategory>;
export const ApprovalRuleInput = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tool"), tool: z.string().min(1).max(160) }),
    z.object({ kind: z.literal("connector"), connectorId: z.string().min(1).max(80) }),
    z.object({ kind: z.literal("category"), category: RuleCategory }),
  ]),
  action: z.enum(["always_allow", "require_approval"]),
});
export type ApprovalRuleInput = z.infer<typeof ApprovalRuleInput>;
export type ApprovalRule = ApprovalRuleInput & { id: string; createdAt: string };

// ---------- Settings ----------

export const Preferences = z.object({
  theme: z.enum(["system", "light", "dark"]),
  sendWithEnter: z.boolean(),
  showToolActivity: z.boolean(),
  density: z.enum(["comfortable", "compact"]),
  /** The language voice typing listens for. */
  dictation: z.enum(Object.keys(dictationLanguages) as [DictationLanguage, ...DictationLanguage[]]),
});
export type Preferences = z.infer<typeof Preferences>;

/** Voice typing on this computer: its speech model downloads once, then it is ready. */
export type VoiceStatus = {
  state: "unsupported" | "missing" | "downloading" | "ready" | "failed";
  /** How much of the one-time download has arrived, from 0 to 1. */
  progress: number;
  error: string | null;
};

export type SkillView = { name: string; description: string; builtIn: boolean };
export type Usage = { runs: number; inputTokens: number; outputTokens: number };

export type Environment = {
  shell: string;
  workspaceDir: string;
  computer: { available: boolean; driver: string };
  browser: { channel: string; headless: boolean };
};

export type AppState = {
  space: SpaceView & { kind: SpaceKind };
  profile: Profile;
  candidate: Candidate;
  applications: Application[];
  habits: Habit[];
  /** Platforms the bots' shared browser is signed in to. */
  browserSignIns: PlatformId[];
  browsers: BrowserView[];
  channel: Channel | null;
  bots: Bot[];
  groups: Group[];
  routines: Routine[];
  models: ModelSettings;
  connections: ConnectionView[];
  mcpServers: McpServerView[];
  approvalRules: ApprovalRule[];
  preferences: Preferences;
  google: { configured: boolean; clientId: string | null; redirectUri: string };
  skills: SkillView[];
  usage: Usage;
  environment: Environment;
};

// ---------- Runs ----------

export const RunInput = z.object({
  botId: BotId,
  task: z.string().trim().min(1).max(8000),
  attachments: z.array(z.string().max(1000)).max(20).default([]),
});

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export type RunTrigger =
  | { kind: "manual" }
  | { kind: "routine"; routineId: string; name: string }
  | { kind: "delegation"; fromBotId: BotId }
  /** Another member of a group chat passed the conversation on. */
  | { kind: "handoff"; fromBotId: BotId };

/** Adding a browser signed in to Gemini, or choosing the channel uploads go to. */
export type TakeoverAction = "add-browser" | "choose-channel";

export type ToolStepStatus = "approval" | "running" | "done" | "denied" | "error";

export type RunStep =
  | { kind: "message"; id: string; at: string; text: string }
  | {
      kind: "tool";
      id: string;
      at: string;
      /** A computer group, "team" for delegation, or the integration it belongs to. */
      group: string;
      tool: string;
      input: Record<string, unknown>;
      status: ToolStepStatus;
      /** What a pending step waits for: an approval, or a person at the computer. */
      gate: /** `why` says why it asks when the bot's access alone would not have. */
        | { kind: "approval"; allowAlways: boolean; summary: string; why?: string }
        /** `action` is what the person is asked to do, when it is more than using the computer. */
        | { kind: "takeover"; reason: string; action?: TakeoverAction }
        | null;
      /** How a person answered the gate, kept so the card can show it. */
      decision?: "allow" | "always" | "deny";
      output?: string;
      childRunId?: string;
      endedAt?: string;
    };

export type Run = {
  id: string;
  botId: BotId;
  task: string;
  attachments: string[];
  status: RunStatus;
  trigger: RunTrigger;
  parentRunId: string | null;
  depth: number;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
  error: string | null;
  steps: RunStep[];
  usage: { inputTokens: number; outputTokens: number };
  /** A reply in a group chat, and the message of yours it answers (shared by every bot that replies). */
  groupId?: string | null;
  messageId?: string | null;
  /** How many times the run picked up again after the app restarted in the middle of it. */
  resumes?: number;
};

// ---------- Computer ----------

/** A terminal command a bot ran, streamed to the Terminal while it runs. */
export type CommandLog = {
  id: string;
  runId: string;
  botId: BotId;
  /** A shell command, a file the bot wrote, or a page it opened. */
  kind: "command" | "write" | "open";
  command: string;
  output: string;
  status: "running" | "done" | "failed";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
};

/** `key` is unique across the space's browsers (see tabKey); `browser` is the one it is in. */
export type BrowserTab = { key: string; browser: string; title: string; url: string };
export type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number; modifiedAt: string };
export type TerminalSession = { id: string; title: string; createdAt: string; exited: boolean };
/** Who drives each bot's computer right now. */
export type ControlState = Partial<Record<BotId, { holder: "you"; since: string }>>;

export type ServerEvent =
  | { type: "state"; state: AppState }
  | { type: "run"; run: Run }
  | { type: "command"; command: CommandLog }
  | { type: "browser"; tabs: BrowserTab[] }
  | { type: "files" }
  | { type: "terminals"; terminals: TerminalSession[] }
  | { type: "control"; control: ControlState };
