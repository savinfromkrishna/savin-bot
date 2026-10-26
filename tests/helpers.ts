import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { EventBus } from "../src/server/events.ts";
import type { Completion, CompletionRequest, LlmProvider } from "../src/server/llm/types.ts";
import { Runtime } from "../src/server/runtime.ts";
import { Secrets } from "../src/server/secrets.ts";
import type { StoredState } from "../src/server/store.ts";
import { Store } from "../src/server/store.ts";
import type { Tool } from "../src/server/tools/tool.ts";
import { defineTool } from "../src/server/tools/tool.ts";
import type { Run, VoiceAssets } from "../src/server/voice.ts";
import { Voice } from "../src/server/voice.ts";
import type { Environment, PlatformId, RuleCategory } from "../src/shared/contracts.ts";

/** The first bytes of a browser's WebM recording. */
export const webmRecording = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);

/**
 * Voice typing with small stand-in downloads and programs: tar unpacks a CLI, ffmpeg writes five seconds of
 * audio and whisper-cli writes `transcript`. Nothing touches the network or runs a real model.
 */
export function fakeVoice(dir: string, transcript = "Coordinator, find ten React jobs in Pune.") {
  const content = { engine: "engine archive", speech: "speech model", vad: "speech detector" };
  const pinned = (name: string, text: string) => ({
    url: `https://downloads.example/${name}`,
    sha256: createHash("sha256").update(text).digest("hex"),
    size: Buffer.byteLength(text),
  });
  const assets: VoiceAssets = {
    engine: { ...pinned("engine.zip", content.engine), unpack: "zip", cli: "Release/whisper-cli.exe" },
    speech: { ...pinned("speech.bin", content.speech), file: "speech.bin" },
    vad: { ...pinned("vad.bin", content.vad), file: "vad.bin" },
  };
  const served = new Map<string, string>([
    [assets.engine.url, content.engine],
    [assets.speech.url, content.speech],
    [assets.vad.url, content.vad],
  ]);
  const fetched: string[] = [];
  const runs: { command: string; args: string[] }[] = [];
  const fetchFake = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    const body = served.get(String(url));
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  const run: Run = async (command, args) => {
    runs.push({ command, args });
    const program = basename(command).toLowerCase();
    if (program.startsWith("tar")) {
      const into = args[args.indexOf("-C") + 1] ?? "";
      await mkdir(join(into, "Release"), { recursive: true });
      await writeFile(join(into, "Release", "whisper-cli.exe"), "cli");
    } else if (program.startsWith("ffmpeg")) {
      await writeFile(args.at(-1) ?? "", Buffer.alloc(44 + 32_000 * 5));
    } else {
      await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, ` [BLANK_AUDIO]\n ${transcript}\n`);
    }
  };
  const voice = new Voice(dir, { assets, fetch: fetchFake, run, threads: 2 });
  return { voice, assets, served, fetched, runs };
}

/** A model that answers from a script keyed by which bot is asking and how many times it has. */
export function scripted(
  script: (botName: string, request: CompletionRequest, turn: number) => Completion,
): LlmProvider {
  const turns = new Map<string, number>();
  return {
    async complete(request) {
      const system = request.messages[0]?.content ?? "";
      const botName = /^You are (\w+)/.exec(typeof system === "string" ? system : "")?.[1] ?? "?";
      const turn = turns.get(botName) ?? 0;
      turns.set(botName, turn + 1);
      return script(botName, request, turn);
    },
  };
}

export const call = (
  name: string,
  input: Record<string, unknown>,
  id = `${name}_${Math.random().toString(36).slice(2, 7)}`,
) => ({
  id,
  name,
  arguments: JSON.stringify(input),
});

export const reply = (content: string): Completion => ({ content, toolCalls: [] });

/** The teammates a request's delegate tool offers, or none when the bot cannot delegate. */
export const delegateTeam = (request: CompletionRequest) => {
  const parameters = request.tools.find((tool) => tool.name === "delegate")?.parameters as
    | { properties: { bot: { enum: string[] } } }
    | undefined;
  return parameters?.properties.bot.enum ?? [];
};

/** A tool that records its calls and answers with a fixed text. */
export function fakeTool(
  name: string,
  group: string,
  extra: { readOnly?: boolean; connectorId?: string; category?: RuleCategory; result?: string } = {},
): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const tool = defineTool({
    name,
    group,
    description: "test",
    readOnly: extra.readOnly,
    connectorId: extra.connectorId,
    category: extra.category,
    input: z.object({ value: z.string().optional() }),
    run: async (input) => {
      calls.push(input);
      return { text: extra.result ?? `${name} ok` };
    },
  });
  return Object.assign(tool, { calls });
}

export async function setup(options: {
  provider: LlmProvider;
  tools?: Tool[];
  integrationTools?: Tool[];
  change?: (state: StoredState) => StoredState;
  browserSignIns?: PlatformId[];
  maxTurns?: number;
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "savin-social-test-"));
  const secrets = Secrets.open(join(dataDir, "secret.key"));
  const store = await Store.open(dataDir, secrets);
  if (options.change) await store.update(options.change);
  const events = new EventBus();
  const environment: Environment = {
    shell: "test shell",
    workspaceDir: store.workspaceDir,
    computer: { available: false, driver: "none" },
    browser: { channel: "chromium", headless: true },
  };
  const runtime = new Runtime({
    store,
    events,
    environment,
    tools: options.tools ?? [],
    integrations: { toolsFor: () => options.integrationTools ?? [] },
    skills: async () => [],
    models: () => [{ provider: options.provider, choice: { providerId: "test", model: "test-model" }, label: "test" }],
    browserSignIns: async () => options.browserSignIns ?? [],
    maxTurns: options.maxTurns,
  });
  return { store, events, runtime, environment, dataDir, secrets };
}

/** Polls until the condition holds; runs progress asynchronously. */
export async function until(condition: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
