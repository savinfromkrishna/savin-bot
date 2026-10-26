import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { profileStrength } from "../shared/coach.ts";
import type {
  Bot,
  BotId,
  ControlState,
  Environment,
  ModelChoice,
  PlatformId,
  Run,
  RunStatus,
  RunStep,
  RunTrigger,
  SkillView,
} from "../shared/contracts.ts";
import { jobsLockedGroups } from "../shared/ids.ts";
import { approvalFor, describeInput } from "./approvals.ts";
import { botViews, openCredentials } from "./bots.ts";
import type { EventBus } from "./events.ts";
import type { ModelTarget } from "./llm/models.ts";
import { thinkingFor } from "./llm/models.ts";
import type { ChatMessage, Completion, CompletionRequest, ToolCall } from "./llm/types.ts";
import { systemPrompt } from "./prompt.ts";
import type { Store } from "./store.ts";
import { videosToday } from "./store.ts";
import { habitLine } from "./tools/coach.ts";
import { appliedToday } from "./tools/jobs.ts";
import { delegateTool, handoffTool } from "./tools/team.ts";
import type { Tool, ToolContext, ToolResult } from "./tools/tool.ts";
import { toolSpec, workspacePath } from "./tools/tool.ts";
import type { CommandLogs } from "./workspace/terminals.ts";

export type RuntimeOptions = {
  store: Store;
  events: EventBus;
  environment: Environment;
  /** Built-in tools: the computer groups (screen, browser, files, shell), web and knowledge. */
  tools: Tool[];
  integrations: { toolsFor(botId: BotId): Tool[] };
  skills: () => Promise<SkillView[]>;
  activity?: Pick<CommandLogs, "note">;
  /** Tells viewers the configuration changed, for example after "Always allow". */
  announce?: () => void;
  /** Which models to try, in order: the space's choices resolved with its owner's connections. */
  models: (override: ModelChoice | null) => ModelTarget[];
  /** Platforms the shared browser is signed in to, so every bot knows which sessions the team has. */
  browserSignIns?: () => Promise<PlatformId[]>;
  maxTurns?: number;
  maxDepth?: number;
  /** Waits before trying a model again after a passing failure (busy, rate-limited, dropped connection). */
  retryDelays?: number[];
};

type ToolStep = Extract<RunStep, { kind: "tool" }>;
type Decision = "allow" | "always" | "deny";
type Live = {
  controller: AbortController;
  gates: Map<string, (decision: Decision) => void>;
  done: Promise<Run>;
  /** The run took in outside content (web pages, apps, attached files), so commands ask a person first. */
  outside: boolean;
  /** Kinds of action a person allowed for the rest of this run, such as saving on one site. */
  allowed: Set<string>;
  /** Stopped for a shutdown: it stays unfinished on disk, so the next start picks it up. */
  suspended?: boolean;
};

const computerGroups = new Set(["screen", "browser", "files", "shell", "video", "web"]);
/**
 * Text from outside can carry instructions aimed at the bots (prompt injection). Once a run has read
 * any, its terminal commands and desktop actions wait for a person, whatever the bot's access.
 */
const takesInOutside = (tool: Tool) =>
  tool.group === "browser" || tool.group === "web" || Boolean(tool.connectorId) || tool.name.startsWith("mcp__");
const askedAfterOutside = new Set(["shell", "screen", "coach"]);
const outsideWhy = (group: string) =>
  group === "coach"
    ? "This task read outside content, so changes to your profile and habits wait for you."
    : "This task read outside content, so commands wait for you.";
/** Attached text is shown to the bot up to this many characters; it reads the rest with files_read. */
const ATTACHED_TEXT_CHARS = 30_000;
const textTypes = new Set([".md", ".txt", ".csv", ".json"]);

/** How many times a run interrupted by a restart picks up again before it is given up on. */
const MAX_RESUMES = 3;
/** Tool groups that only touch this computer; any other step read something from outside. */
const localGroups = new Set(["files", "shell", "screen", "video", "knowledge", "team", "coach"]);
/**
 * Failures worth trying the same model again for: busy, rate-limited, or a dropped connection, including
 * the SDKs' own "Connection error." and a stream cut off part-way ("terminated").
 */
const passing = (error: unknown) =>
  /\b(408|409|425|429|500|502|503|504|529)\b|overloaded|rate.?limit|too many requests|timed? ?out|connection (error|reset|closed)|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|terminated|network/i.test(
    messageOf(error),
  );
const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** What a run did before a restart stopped it, so the model carries on instead of starting over. */
function progressNote(run: Run) {
  const lines = run.steps.flatMap((step) => {
    if (step.kind === "message") return [`- You said: ${oneLine(step.text, 300)}`];
    const input = oneLine(JSON.stringify(step.input), 200);
    const outcome =
      step.status === "done"
        ? oneLine(step.output ?? "done", 300)
        : step.status === "denied"
          ? "the person declined this"
          : step.status === "error" && step.output !== "Interrupted by a restart"
            ? `failed: ${oneLine(step.output ?? "", 200)}`
            : "cut off by the restart; check whether it happened before doing it again";
    return [`- ${step.tool} ${input} → ${outcome}`];
  });
  return [
    "The app restarted while you were working on this, so you are picking it up again. What you did before it stopped, oldest first:",
    ...(lines.length > 60 ? ["- (earlier steps left out)", ...lines.slice(-60)] : lines),
    "Carry on from where you stopped. Do not redo what is done: look at the current state first (open the page again, list the files) and continue from there.",
  ].join("\n");
}

/** Once a run's tool results add up to this much text, all but the newest are shortened, so long tasks fit. */
const COMPACT_ABOVE_CHARS = 150_000;
const KEEP_RECENT_RESULTS = 12;
/** What the last step of a run asks for, so a long task ends with a report rather than an error. */
const STEP_LIMIT_NOTE =
  "You have used all the steps this task may take. Do not call any more tools. Reply now with what you finished, what is left, and that the person can say “continue” for you to finish it.";
const STOPPED_NOTE =
  "I reached this task's step limit before finishing. Say “continue” and I'll pick up where I stopped.";

/** Shortens tool results the model has moved past; it happens rarely, so the prompt cache mostly holds. */
function compact(messages: ChatMessage[]) {
  const results = messages.filter((message) => message.role === "tool");
  if (results.reduce((sum, message) => sum + message.content.length, 0) <= COMPACT_ABOVE_CHARS) return;
  for (const message of results.slice(0, -KEEP_RECENT_RESULTS)) {
    if (message.content.length > 600) message.content = `${message.content.slice(0, 500)}\n… (older result shortened)`;
  }
}

/** Replies one group message can collect, hand-offs included, so members cannot pass it around forever. */
const MAX_GROUP_REPLIES = 12;
const now = () => new Date().toISOString();
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const finished = (status: RunStatus) => status === "succeeded" || status === "failed" || status === "cancelled";

const abortable = <T>(work: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Runs bots: model turns, tool calls, approvals, takeovers and delegation between bots. */
export class Runtime {
  private runs = new Map<string, Run>();
  private live = new Map<string, Live>();
  private control: ControlState = {};
  private usageTimer: NodeJS.Timeout | undefined;
  private pendingUsage = { runs: 0, inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: RuntimeOptions) {}

  /** Loads history. Runs that were in flight when the server stopped are closed as failed. */
  /**
   * Loads the saved runs. One the app stopped in the middle of picks up where it was; work it had handed to a
   * teammate is redone by the run that handed it down, and a run that keeps being interrupted is given up on.
   */
  async restore() {
    const interrupted: Run[] = [];
    for (const run of (await this.options.store.loadRuns()).reverse()) {
      this.runs.set(run.id, run);
      if (!finished(run.status)) interrupted.push(run);
    }
    for (const run of interrupted) {
      const resumes = run.resumes ?? 0;
      if (run.parentRunId) this.close(run, "failed", null, "Interrupted by a restart");
      else if (resumes >= MAX_RESUMES) {
        this.close(run, "failed", null, `Stopped after ${resumes} restarts in a row without finishing`);
      } else this.resume(run);
    }
  }

  /** Runs an interrupted run again from what it had done, keeping it in the same thread. */
  private resume(run: Run) {
    const note = progressNote(run);
    for (const step of run.steps) {
      if (step.kind === "tool" && (step.status === "running" || step.status === "approval")) {
        step.status = "error";
        step.gate = null;
        step.output ??= "Interrupted by a restart";
      }
    }
    Object.assign(run, { status: "running", endedAt: null, error: null, resumes: (run.resumes ?? 0) + 1 });
    run.steps.push({
      kind: "message",
      id: randomUUID(),
      at: now(),
      text: "The app restarted, so I'm picking up where I left off.",
    });
    const live: Live = {
      controller: new AbortController(),
      gates: new Map(),
      done: Promise.resolve(run),
      // Whatever it had read from outside before the restart still shapes what it does next.
      outside:
        run.attachments.length > 0 || run.steps.some((step) => step.kind === "tool" && !localGroups.has(step.group)),
      allowed: new Set(),
    };
    this.live.set(run.id, live);
    this.changed(run, true);
    const routine =
      run.trigger.kind === "routine"
        ? this.options.store.state.routines.find(
            (candidate) => candidate.id === (run.trigger as { routineId: string }).routineId,
          )
        : undefined;
    live.done = this.execute(run, live, routine?.model ?? null, note).then(() => {
      this.live.delete(run.id);
      return run;
    });
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string) {
    return this.runs.get(id);
  }

  bots() {
    return botViews(this.options.store.state);
  }

  // ---------- Control of a bot's computer ----------

  controlState() {
    return this.control;
  }

  takeControl(botId: BotId) {
    this.control = { ...this.control, [botId]: { holder: "you", since: now() } };
    this.options.events.emit({ type: "control", control: this.control });
  }

  releaseControl(botId: BotId) {
    const { [botId]: _released, ...rest } = this.control;
    this.control = rest;
    this.options.events.emit({ type: "control", control: this.control });
  }

  // ---------- Runs ----------

  start(
    botId: BotId,
    task: string,
    trigger: RunTrigger,
    extra: {
      parent?: Run;
      attachments?: string[];
      model?: ModelChoice | null;
      /** A reply in a group chat, to the message it answers. */
      group?: { id: string; messageId: string };
    } = {},
  ): Run {
    const { parent } = extra;
    const run: Run = {
      id: randomUUID(),
      botId,
      task,
      attachments: extra.attachments ?? [],
      status: "running",
      trigger,
      parentRunId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      startedAt: now(),
      endedAt: null,
      result: null,
      error: null,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(extra.group && { groupId: extra.group.id, messageId: extra.group.messageId }),
    };
    const live: Live = {
      controller: new AbortController(),
      gates: new Map(),
      done: Promise.resolve(run),
      // Attached files come from outside, and so does work handed down from a run that read outside content.
      outside: run.attachments.length > 0 || Boolean(parent && this.live.get(parent.id)?.outside),
      allowed: new Set(),
    };
    this.runs.set(run.id, run);
    this.live.set(run.id, live);
    if (parent) {
      this.live.get(parent.id)?.controller.signal.addEventListener("abort", () => this.cancel(run.id), { once: true });
    }
    this.countUsage({ runs: 1 });
    this.changed(run);
    live.done = this.execute(run, live, extra.model ?? null).then(() => {
      this.live.delete(run.id);
      return run;
    });
    return run;
  }

  /** Resolves when the run has finished, however it ended. */
  wait(runId: string): Promise<Run | undefined> {
    return this.live.get(runId)?.done ?? Promise.resolve(this.runs.get(runId));
  }

  cancel(runId: string) {
    const live = this.live.get(runId);
    if (!live) return false;
    live.controller.abort(new Error("Cancelled"));
    for (const resolve of live.gates.values()) resolve("deny");
    return true;
  }

  /**
   * Stops every run for a shutdown without ending it. Each stays unfinished on disk, and the next start
   * picks it up where it was (restore), where cancelling would lose it.
   */
  async suspend() {
    const lives = [...this.live.values()];
    for (const live of lives) live.suspended = true;
    for (const live of lives) {
      live.controller.abort(new Error("Stopped for a restart"));
      for (const resolve of live.gates.values()) resolve("deny");
    }
    await Promise.all(lives.map((live) => live.done));
  }

  /** Answers a waiting step: allow once, always allow this tool, or deny (skip, for a takeover). */
  decide(runId: string, stepId: string, decision: Decision) {
    const resolve = this.live.get(runId)?.gates.get(stepId);
    resolve?.(decision);
    return Boolean(resolve);
  }

  /** Stops and erases a bot's conversation (or a group's), when it is deleted. */
  async forget(which: { botId: BotId } | { groupId: string }) {
    const runs = [...this.runs.values()].filter((run) =>
      "botId" in which ? run.botId === which.botId : run.groupId === which.groupId,
    );
    for (const run of runs) this.cancel(run.id);
    await Promise.all(runs.map((run) => this.wait(run.id)));
    for (const run of runs) this.runs.delete(run.id);
    await this.options.store.deleteRuns(runs.map((run) => run.id));
  }

  private async execute(run: Run, live: Live, modelOverride: ModelChoice | null, resumed?: string) {
    const { signal } = live.controller;
    const { store, environment, maxTurns = 150, maxDepth = 3 } = this.options;
    try {
      const bots = this.bots();
      const bot = bots.find((candidate) => candidate.id === run.botId);
      if (!bot) throw new Error(`Unknown bot ${run.botId}`);
      const chain = this.chain(run);
      const team =
        bot.delegation && run.depth < maxDepth
          ? bots.filter((other) => other.id !== bot.id && !chain.includes(other.id))
          : [];
      const group = run.groupId ? store.state.groups.find((candidate) => candidate.id === run.groupId) : undefined;
      const members = group ? bots.filter((other) => group.botIds.includes(other.id)) : [];
      const others = members.filter((other) => other.id !== bot.id);
      const integrationTools = this.options.integrations.toolsFor(bot.id);
      const jobs = store.state.kind === "jobs";
      // A job search space never hands out the terminal, the desktop or Gemini video, whatever a bot's switches say.
      const locked = new Set<string>(jobs ? jobsLockedGroups : []);
      const tools = [
        ...this.options.tools.filter((tool) => {
          if (locked.has(tool.group)) return false;
          // The person's profile and habits are the lead's to keep, not every teammate's.
          if (tool.group === "coach") return bot.delegation;
          if (!computerGroups.has(tool.group)) return true;
          if (bot.computerAccess === "off") return false;
          return tool.group === "web" || bot.tools[tool.group as keyof Bot["tools"]];
        }),
        ...(team.length ? [delegateTool(team)] : []),
        ...(others.length ? [handoffTool(others)] : []),
        ...integrationTools,
      ].filter((tool) => !bot.disabledTools.includes(tool.name));
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const specs = tools.map(toolSpec);
      const apps = [...new Set(integrationTools.map((tool) => tool.group))];
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: systemPrompt({
            bot,
            bots,
            team,
            kind: store.state.kind,
            profile: store.state.profile,
            candidate: store.state.candidate,
            appliedToday: appliedToday(store.state.applications),
            environment,
            skills: await this.options.skills(),
            apps,
            signedIn: (await this.options.browserSignIns?.().catch(() => [])) ?? [],
            channel: store.state.channel,
            videoBrowsers:
              bot.computerAccess !== "off" && bot.tools.video
                ? store.state.browsers.map((browser) => {
                    const today = videosToday(browser);
                    return `- ${browser.name}: ${today.stopped ? `done for today (${today.stopped})` : `${Math.max(0, browser.videoLimit - today.made)} of ${browser.videoLimit} videos left today`}`;
                  })
                : [],
            coaching:
              jobs && bot.delegation
                ? {
                    ...profileStrength(store.state.candidate),
                    habits: store.state.habits.filter((habit) => habit.active).map((habit) => habitLine(habit)),
                  }
                : null,
            group: group ? { name: group.name, members } : undefined,
            today: new Date().toDateString(),
          }),
        },
        ...(group ? [] : this.history(run, bot)),
        {
          role: "user",
          content: [
            ...(group ? [this.groupTranscript(run, bots)] : []),
            run.trigger.kind === "handoff"
              ? `${bots.find((other) => run.trigger.kind === "handoff" && other.id === run.trigger.fromBotId)?.name ?? "A teammate"} handed this to you: ${run.task}`
              : group
                ? `New message from the person: ${run.task}`
                : run.task,
            ...(run.attachments.length ? [await this.attached(run.attachments)] : []),
            ...(resumed ? [resumed] : []),
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ];
      const record = store.state.bots[bot.id];
      const credentials = record ? openCredentials(record, store.secrets) : [];
      let lastCall = "";
      let repeats = 0;

      for (let turn = 0; ; turn++) {
        const last = turn >= maxTurns - 1;
        if (last) messages.push({ role: "user", content: STEP_LIMIT_NOTE });
        compact(messages);
        const completion = await this.complete(run, bot, modelOverride ?? bot.model, {
          messages,
          tools: specs,
          signal,
        });
        messages.push({
          role: "assistant",
          content: completion.content,
          toolCalls: completion.toolCalls,
          native: completion.native,
        });
        if (completion.toolCalls.length === 0) {
          this.close(run, "succeeded", completion.content.trim() || "Done.", null);
          return;
        }
        if (last) {
          // It still wanted to act: whatever it said stands, with a note on how to go on.
          this.close(run, "succeeded", [completion.content.trim(), STOPPED_NOTE].filter(Boolean).join("\n\n"), null);
          return;
        }
        if (completion.content.trim()) {
          this.addStep(run, { kind: "message", id: randomUUID(), at: now(), text: completion.content.trim() });
        }

        // Guard against a model stuck repeating itself.
        const signature = completion.toolCalls.map((call) => call.name + call.arguments).join("|");
        repeats = signature === lastCall ? repeats + 1 : 0;
        lastCall = signature;
        const results: ToolResult[] =
          repeats >= 4
            ? completion.toolCalls.map(() => ({
                text: "You have repeated this exact call several times. Change approach or finish.",
              }))
            : await this.callTools(run, bot.id, byName, completion.toolCalls, live, credentials);

        const images: string[] = [];
        completion.toolCalls.forEach((call, index) => {
          const result = results[index] ?? { text: "" };
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.text });
          if (result.image) images.push(result.image);
        });
        if (images.length) {
          // Only the newest screenshots stay in context; older ones are dropped to save tokens.
          for (const message of messages) if (message.role === "user" && message.images) delete message.images;
          messages.push({ role: "user", content: "Screenshot from the last action.", images });
        }
      }
    } catch (error) {
      if (live.suspended) this.changed(run, true);
      else if (signal.aborted) this.close(run, "cancelled", null, "Cancelled");
      else this.close(run, "failed", null, messageOf(error));
    }
  }

  /** What was said in a group chat before this reply: the person's messages and every member's answers. */
  private groupTranscript(run: Run, bots: Bot[]) {
    const nameOf = (id: BotId) => bots.find((bot) => bot.id === id)?.name ?? id;
    const earlier = this.list()
      .filter((other) => other.groupId === run.groupId && other.id !== run.id && other.startedAt <= run.startedAt)
      .reverse();
    const lines: string[] = [];
    const asked = new Set<string>();
    for (const other of earlier) {
      if (other.trigger.kind === "manual" && other.messageId && !asked.has(other.messageId)) {
        asked.add(other.messageId);
        lines.push(`Person: ${other.task}`);
      }
      if (other.result) lines.push(`${nameOf(other.botId)}: ${other.result}`);
    }
    // The person's newest message comes separately, so it is not repeated here.
    if (run.trigger.kind === "manual" && lines.at(-1) === `Person: ${run.task}`) lines.pop();
    return lines.length ? `Earlier in this group chat:\n${lines.slice(-24).join("\n")}` : "";
  }

  /** Hands a group conversation to another member; the cap stops two bots passing it back and forth. */
  private handoff(run: Run, botId: BotId, note: string) {
    if (!run.groupId || !run.messageId) return "This only works in a group chat.";
    const replies = [...this.runs.values()].filter((other) => other.messageId === run.messageId).length;
    if (replies >= MAX_GROUP_REPLIES) return "This message already has enough replies. Finish with your own answer.";
    this.start(
      botId,
      note,
      { kind: "handoff", fromBotId: run.botId },
      { group: { id: run.groupId, messageId: run.messageId } },
    );
    const name = this.bots().find((bot) => bot.id === botId)?.name ?? botId;
    return `${name} takes it from here and answers in the group.`;
  }

  /**
   * What the person attached: text files (such as a long paste) shown as material to work with, up to a
   * limit, and every other file by its path.
   */
  private async attached(paths: string[]) {
    const files: string[] = [];
    const texts: string[] = [];
    let room = ATTACHED_TEXT_CHARS;
    for (const path of paths) {
      const full = (() => {
        try {
          return workspacePath(this.options.store.workspaceDir, path);
        } catch {
          return null;
        }
      })();
      const info = full && textTypes.has(extname(full).toLowerCase()) ? await stat(full).catch(() => null) : null;
      if (!full || !info?.isFile() || room <= 0) {
        files.push(path);
        continue;
      }
      const text = (await readFile(full, "utf8")).slice(0, room + 1);
      const shown = text.slice(0, room);
      room -= shown.length;
      const more = text.length > shown.length ? " (the start; read the rest with files_read)" : "";
      texts.push(`Attached ${path}${more}:\n"""\n${shown}\n"""`);
    }
    return [...(files.length ? [`Attached files: ${files.join(", ")}`] : []), ...texts].join("\n\n");
  }

  /** Earlier exchanges in this bot's own conversation, since it was last cleared. */
  private history(run: Run, bot: Bot): ChatMessage[] {
    if (run.trigger.kind === "delegation") return [];
    const since = bot.historyClearedAt ?? "";
    return this.list()
      .filter(
        (other) =>
          other.id !== run.id &&
          other.botId === bot.id &&
          other.parentRunId === null &&
          !other.groupId &&
          other.status === "succeeded" &&
          other.startedAt > since &&
          other.startedAt < run.startedAt,
      )
      .slice(0, 8)
      .reverse()
      .flatMap((other): ChatMessage[] => [
        {
          role: "user",
          content: other.attachments.length
            ? `${other.task}\n\nAttached files: ${other.attachments.join(", ")}`
            : other.task,
        },
        { role: "assistant", content: other.result ?? "", toolCalls: [] },
      ]);
  }

  /** Tries the chosen model, then the backups, and counts the tokens used. */
  private async complete(
    run: Run,
    bot: Bot,
    override: ModelChoice | null,
    request: Omit<CompletionRequest, "thinking">,
  ): Promise<Completion> {
    const targets = this.options.models(override);
    if (!targets.length) throw new Error("No model is connected. Add one in Settings → Models.");
    const thinking = thinkingFor(this.options.store.state.thinking, bot.thinking);
    const delays = this.options.retryDelays ?? RETRY_DELAYS_MS;
    let lastError: unknown;
    for (const target of targets) {
      // A passing failure is tried again on the same model a few times before moving to the next one.
      for (let attempt = 0; ; attempt++) {
        try {
          const completion = await target.provider.complete({ ...request, thinking });
          if (completion.usage) {
            run.usage.inputTokens += completion.usage.inputTokens;
            run.usage.outputTokens += completion.usage.outputTokens;
            this.countUsage(completion.usage);
          }
          return completion;
        } catch (error) {
          if (request.signal.aborted) throw error;
          lastError = error;
          const delay = delays[attempt];
          if (delay === undefined || !passing(error)) break;
          await sleep(delay, request.signal);
        }
      }
    }
    throw lastError;
  }

  /** Delegations run in parallel; every other tool runs one at a time, in order. */
  private callTools(
    run: Run,
    botId: BotId,
    tools: Map<string, Tool>,
    calls: ToolCall[],
    live: Live,
    credentials: ToolContext["credentials"],
  ) {
    let queue = Promise.resolve();
    return Promise.all(
      calls.map((call) => {
        const tool = tools.get(call.name);
        if (tool?.group === "team") return this.callTool(run, botId, tool, call, live, credentials);
        const next = queue.then(() => this.callTool(run, botId, tool, call, live, credentials));
        queue = next.then(
          () => {},
          () => {},
        );
        return next;
      }),
    );
  }

  private waitForGate(live: Live, step: ToolStep) {
    return new Promise<Decision>((resolve) => live.gates.set(step.id, resolve)).finally(() =>
      live.gates.delete(step.id),
    );
  }

  private async callTool(
    run: Run,
    botId: BotId,
    tool: Tool | undefined,
    call: ToolCall,
    live: Live,
    credentials: ToolContext["credentials"],
  ): Promise<ToolResult> {
    const { signal } = live.controller;
    signal.throwIfAborted();
    if (!tool) return { text: `There is no tool named "${call.name}".` };

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return { text: "The arguments were not valid JSON." };
    }
    const parsed = tool.parse(raw);
    const step: ToolStep = {
      kind: "tool",
      id: randomUUID(),
      at: now(),
      group: tool.group,
      tool: tool.name,
      input: (parsed.ok ? parsed.value : raw) as Record<string, unknown>,
      status: "running",
      gate: null,
    };
    this.addStep(run, step);
    if (!parsed.ok) return this.endStep(run, step, "error", `Invalid arguments:\n${parsed.error}`);

    // The current settings decide, so changing access or rules applies to the very next action.
    const bot = this.bots().find((candidate) => candidate.id === botId);
    const outside = live.outside && askedAfterOutside.has(tool.group) && !tool.readOnly;
    const gate = outside
      ? { gate: true as const, allowAlways: false }
      : approvalFor(tool, bot?.computerAccess ?? "off", this.options.store.state.approvalRules);
    if (gate.gate) {
      step.status = "approval";
      step.gate = {
        kind: "approval",
        allowAlways: gate.allowAlways,
        summary: describeInput(step.input),
        ...(outside && { why: outsideWhy(tool.group) }),
      };
      this.refreshStatus(run);
      const decision = await this.waitForGate(live, step);
      signal.throwIfAborted();
      step.decision = decision === "always" && !gate.allowAlways ? "allow" : decision;
      if (decision === "deny") {
        return this.endStep(
          run,
          step,
          "denied",
          "A person declined this action. Do not retry it; continue without it or explain what you need.",
        );
      }
      if (decision === "always" && gate.allowAlways) await this.allowAlways(tool.name);
      step.status = "running";
      this.refreshStatus(run);
    }

    const context: ToolContext = {
      runId: run.id,
      botId,
      signal,
      workspaceDir: this.options.store.workspaceDir,
      credentials,
      delegate: (target, task) => this.delegate(run, live, step, target, task),
      handoff: async (target, note) => this.handoff(run, target, note),
      requestApproval: async (summary, why, scope) => {
        if (scope && live.allowed.has(scope)) return true;
        step.status = "approval";
        step.gate = { kind: "approval", allowAlways: false, summary, why };
        this.refreshStatus(run);
        const decision = await this.waitForGate(live, step);
        signal.throwIfAborted();
        step.decision = decision === "deny" ? "deny" : "allow";
        step.status = "running";
        this.refreshStatus(run);
        if (scope && decision !== "deny") live.allowed.add(scope);
        return decision !== "deny";
      },
      requestTakeover: async (reason, action) => {
        step.status = "approval";
        step.gate = { kind: "takeover", reason, ...(action && { action }) };
        this.refreshStatus(run);
        const decision = await this.waitForGate(live, step);
        signal.throwIfAborted();
        step.decision = decision === "deny" ? "deny" : "allow";
        step.status = "running";
        this.refreshStatus(run);
        return decision !== "deny";
      },
      waitForControl: async () => {
        while (this.control[botId]) await sleep(500, signal);
      },
      activity: (kind, text) => this.options.activity?.note(run.id, botId, kind, text),
    };
    try {
      const result = await abortable(tool.run(parsed.value, context), signal);
      if (takesInOutside(tool)) live.outside = true;
      this.endStep(run, step, "done", result.text + (result.image ? "\n[image]" : ""));
      return { ...result, text: clip(result.text, 12_000) };
    } catch (error) {
      if (signal.aborted) throw error;
      return this.endStep(run, step, "error", `Error: ${messageOf(error)}`);
    }
  }

  private async allowAlways(tool: string) {
    const { store } = this.options;
    if (store.state.approvalRules.some((rule) => rule.target.kind === "tool" && rule.target.tool === tool)) return;
    await store.update((state) => ({
      ...state,
      approvalRules: [
        ...state.approvalRules.filter((rule) => !(rule.target.kind === "tool" && rule.target.tool === tool)),
        { id: randomUUID(), createdAt: now(), target: { kind: "tool", tool }, action: "always_allow" },
      ],
    }));
    this.options.announce?.();
  }

  private async delegate(parent: Run, live: Live, step: ToolStep, botId: BotId, task: string) {
    const child = this.start(botId, task, { kind: "delegation", fromBotId: parent.botId }, { parent });
    const childLive = this.live.get(child.id);
    step.childRunId = child.id;
    this.changed(parent);
    const result = await this.wait(child.id);
    // A report written after reading outside content can carry its instructions up to the lead.
    if (childLive?.outside) live.outside = true;
    const name = this.bots().find((bot) => bot.id === botId)?.name ?? botId;
    return result?.status === "succeeded"
      ? `${name} reports:\n${result.result ?? ""}`
      : `${name} did not finish (${result?.status ?? "unknown"}): ${result?.error ?? "no details"}`;
  }

  /** Bots already in this delegation chain, so work never loops back up. */
  private chain(run: Run) {
    const ids: BotId[] = [];
    for (
      let current: Run | undefined = run;
      current;
      current = current.parentRunId ? this.runs.get(current.parentRunId) : undefined
    ) {
      ids.push(current.botId);
    }
    return ids;
  }

  private addStep(run: Run, step: RunStep) {
    run.steps.push(step);
    this.changed(run);
  }

  private endStep(run: Run, step: ToolStep, status: ToolStep["status"], output: string): ToolResult {
    step.status = status;
    step.output = clip(output, 2000);
    step.endedAt = now();
    this.refreshStatus(run);
    return { text: output };
  }

  private refreshStatus(run: Run) {
    if (!finished(run.status)) {
      run.status = run.steps.some((step) => step.kind === "tool" && step.status === "approval") ? "waiting" : "running";
    }
    this.changed(run);
  }

  private close(run: Run, status: RunStatus, result: string | null, error: string | null) {
    for (const step of run.steps) {
      if (step.kind === "tool" && (step.status === "running" || step.status === "approval")) {
        step.status = status === "cancelled" ? "denied" : "error";
        step.output ??= error ?? undefined;
      }
    }
    Object.assign(run, { status, result, error, endedAt: now() });
    this.changed(run, true);
  }

  private changed(run: Run, persistNow = false) {
    this.options.events.emit({ type: "run", run });
    this.options.store.saveRun(run, persistNow || finished(run.status));
  }

  /** Usage is saved in batches so a busy run does not rewrite the state file on every turn. */
  private countUsage(delta: { runs?: number; inputTokens?: number; outputTokens?: number }) {
    this.pendingUsage.runs += delta.runs ?? 0;
    this.pendingUsage.inputTokens += delta.inputTokens ?? 0;
    this.pendingUsage.outputTokens += delta.outputTokens ?? 0;
    this.usageTimer ??= setTimeout(() => {
      this.usageTimer = undefined;
      const pending = this.pendingUsage;
      this.pendingUsage = { runs: 0, inputTokens: 0, outputTokens: 0 };
      void this.options.store.update((state) => ({
        ...state,
        usage: {
          runs: state.usage.runs + pending.runs,
          inputTokens: state.usage.inputTokens + pending.inputTokens,
          outputTokens: state.usage.outputTokens + pending.outputTokens,
        },
      }));
    }, 2000);
  }
}
