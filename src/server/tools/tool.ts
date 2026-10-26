import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { BotId, RuleCategory, TakeoverAction } from "../../shared/contracts.ts";
import type { ToolSpec } from "../llm/types.ts";

export type ToolResult = {
  text: string;
  /** JPEG or PNG data URL shown to the model. */
  image?: string;
};

/** A bot credential with its secret opened; only tools ever see the secret part. */
export type OpenCredential =
  | { type: "bearer"; domain: string; token: string }
  | { type: "header"; domain: string; header: string; value: string }
  | { type: "basic"; domain: string; username: string; password: string }
  | { type: "login"; domain: string; username: string; password: string }
  | { type: "variable"; name: string; value: string };

export type ToolContext = {
  runId: string;
  botId: BotId;
  signal: AbortSignal;
  workspaceDir: string;
  credentials: OpenCredential[];
  delegate: (botId: BotId, task: string) => Promise<string>;
  /** In a group chat: passes the conversation to another member, who answers next in the thread. */
  handoff: (botId: BotId, note: string) => Promise<string>;
  /**
   * Pauses for a person's Allow or Deny on what the tool is about to do; false when they deny it. Once they
   * allow an action with a `scope`, the rest of the run's actions with that scope go ahead without asking.
   */
  requestApproval: (summary: string, why: string, scope?: string) => Promise<boolean>;
  /** Pauses the run until a person has finished at the computer (or done `action`); false when they skip. */
  requestTakeover: (reason: string, action?: TakeoverAction) => Promise<boolean>;
  /** Waits while a person holds this bot's computer. */
  waitForControl: () => Promise<void>;
  /** Adds a line to the computer's activity feed. */
  activity: (kind: "write" | "open", text: string) => void;
};

export type Tool = {
  name: string;
  /** A computer group (screen, browser, files, shell), "team", "knowledge", "web", or an integration. */
  group: string;
  description: string;
  /** JSON Schema shown to the model. */
  parameters: Record<string, unknown>;
  /** Only observes, so it never waits for approval. */
  readOnly?: boolean;
  /** What approval presets match ("Ask before publishing"). */
  category?: RuleCategory;
  /** The integration this tool belongs to, for connector-level rules. */
  connectorId?: string;
  parse(input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
};

/** A tool whose input is checked with a zod schema. */
export const defineTool = <S extends z.ZodObject>(
  tool: Omit<Tool, "parameters" | "parse" | "run"> & {
    input: S;
    run(input: z.output<S>, context: ToolContext): Promise<ToolResult>;
  },
): Tool => {
  const { input, run, ...rest } = tool;
  return {
    ...rest,
    parameters: z.toJSONSchema(input, { target: "openapi-3.0", io: "input" }) as Record<string, unknown>,
    parse(value) {
      const parsed = input.safeParse(value);
      return parsed.success
        ? { ok: true, value: parsed.data as Record<string, unknown> }
        : { ok: false, error: z.prettifyError(parsed.error) };
    },
    run: (value, context) => run(value as z.output<S>, context),
  };
};

export const toolSpec = (tool: Tool): ToolSpec => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
});

/** Resolves a path the model gave against the workspace and refuses anything outside it. */
export function workspacePath(workspaceDir: string, path: string) {
  const full = resolve(workspaceDir, path.replace(/^[/\\]+/, ""));
  const inside = relative(workspaceDir, full);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${path} is outside the workspace`);
  return full;
}

/** Read-only judged by name, the way savin treats tools that declare nothing. */
export const looksReadOnly = (name: string) =>
  /(^|_)(get|list|search|find|read|fetch|query|describe|lookup|view|show|count|stats|analytics|insights)(_|$)/i.test(
    name.replace(/^mcp__[a-z0-9-]+__/i, ""),
  );
