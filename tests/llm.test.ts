import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { catalog } from "../src/server/llm/catalog.ts";
import { listModels } from "../src/server/llm/compatible.ts";
import { sealedCredentials } from "../src/server/llm/credentials.ts";
import { demoProvider } from "../src/server/llm/demo.ts";
import { modelChain } from "../src/server/llm/models.ts";
import { piProvider, reasoningFor } from "../src/server/llm/pi.ts";
import { SignIns } from "../src/server/llm/sign-in.ts";
import type { ChatMessage } from "../src/server/llm/types.ts";
import { Secrets } from "../src/server/secrets.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = () => new AbortController().signal;

describe("pi adapter", () => {
  it("runs tool calls through pi and replays the model's own reply on the next turn", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const seen: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxText("Checking."), fauxToolCall("terminal_run", { command: "ls" }, { id: "c1" })], {
        stopReason: "toolUse",
      }),
      (context) => {
        seen.push(...context.messages.map((message) => message.role));
        return fauxAssistantMessage("All done.");
      },
    ]);
    const provider = piProvider(models, faux.getModel());
    const messages: ChatMessage[] = [
      { role: "system", content: "You are Scout." },
      { role: "user", content: "look", images: ["data:image/png;base64,AA=="] },
    ];
    const tools = [{ name: "terminal_run", description: "d", parameters: { type: "object", properties: {} } }];
    const first = await provider.complete({ messages, tools, signal: signal() });
    expect(first).toMatchObject({
      content: "Checking.",
      toolCalls: [{ id: "c1", name: "terminal_run", arguments: '{"command":"ls"}' }],
    });
    const second = await provider.complete({
      messages: [
        ...messages,
        { role: "assistant", content: first.content, toolCalls: first.toolCalls, native: first.native },
        { role: "tool", toolCallId: "c1", name: "terminal_run", content: "a.txt" },
      ],
      tools,
      signal: signal(),
    });
    expect(second.content).toBe("All done.");
    expect(seen).toEqual(expect.arrayContaining(["user", "assistant", "toolResult"]));
  });

  it("reports a failed request as an error", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "quota exceeded" })]);
    await expect(
      piProvider(models, faux.getModel()).complete({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: signal(),
      }),
    ).rejects.toThrow("quota exceeded");
  });

  it("follows savin's thinking rule: reasoning models start at medium, plain ones send nothing", () => {
    const base = { id: "m", name: "m", api: "openai-completions", provider: "p", baseUrl: "", input: ["text"] };
    const reasoning = { ...base, reasoning: true } as unknown as Model<"openai-completions">;
    const plain = { ...base, reasoning: false } as unknown as Model<"openai-completions">;
    expect(reasoningFor(reasoning)).toBe("medium");
    expect(reasoningFor(reasoning, "high")).toBe("high");
    expect(reasoningFor(reasoning, "nonsense")).toBe("medium");
    expect(reasoningFor(plain, "high")).toBeUndefined();
  });
});

describe("model catalog", () => {
  it("offers savin's subscription sign-ins next to API keys and your own server", () => {
    const views = catalog();
    const signIn = Object.fromEntries(views.filter((view) => view.signIn).map((view) => [view.id, view.signIn]));
    expect(signIn).toEqual({
      "openai-codex": { mode: "device-code", label: "Sign in with ChatGPT Plus/Pro" },
      "github-copilot": { mode: "device-code", label: "Sign in with GitHub Copilot" },
      xai: { mode: "device-code", label: "Sign in with SuperGrok or X Premium" },
      anthropic: { mode: "auth-url", label: "Sign in with Claude Pro/Max" },
    });
    const byId = (id: string) => views.find((view) => view.id === id);
    expect(byId("openai-codex")).toMatchObject({ name: "ChatGPT", apiKey: false });
    expect(byId("openai-codex")?.models[0]?.id).toBe("gpt-6.1-sol");
    expect(byId("anthropic")?.models[0]?.id).toBe("claude-sonnet-5-5");
    expect(byId("google")?.models[0]?.id).toBe("gemini-3.8-flash");
    expect(byId("openai")?.keyTest).toBe(true);
    expect(byId("amazon-bedrock")).toBeUndefined();
    expect(views.at(-1)).toMatchObject({ id: "openai-compatible", hint: "Custom server" });
  });

  it("only runs connected providers, with the demo model only as a first choice", () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "a" }, { id: "b" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const access = { models, connected: new Set(["faux"]) };
    const chain = modelChain(
      access,
      {
        active: { providerId: "faux", model: "a" },
        backups: [
          { providerId: "gone", model: "x" },
          { providerId: "faux", model: "b" },
        ],
      },
      null,
    );
    expect(chain.map((target) => target.choice.model)).toEqual(["a", "b"]);
    expect(modelChain(access, { active: null, backups: [] }, null).map((target) => target.label)).toEqual([
      "Demo model",
    ]);
    expect(
      modelChain({ models, connected: new Set() }, { active: { providerId: "faux", model: "a" }, backups: [] }, null),
    ).toEqual([]);
  });
});

describe("sealed credentials", () => {
  it("keeps tokens sealed at rest and writes one provider at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savin-social-credentials-"));
    let records: Record<string, string> = {};
    const store = sealedCredentials(
      {
        read: () => records,
        write: async (change) => {
          records = change(records);
        },
      },
      Secrets.open(join(dir, "secret.key")),
    );
    await Promise.all([
      store.modify("openai", async () => ({ type: "api_key", key: "sk-first" })),
      store.modify("openai", async (current) => ({
        type: "api_key",
        key: `${current?.type === "api_key" ? current.key : ""}+second`,
      })),
    ]);
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-first+second" });
    expect(JSON.stringify(records)).not.toContain("sk-first");
    expect(await store.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
  });
});

describe("subscription sign-in", () => {
  const deviceLogin = () => {
    let finish = () => {};
    const login = (_user: string, _provider: string, interaction: AuthInteraction) => {
      interaction.notify({
        type: "device_code",
        userCode: "WXYZ-0000",
        verificationUri: "https://example.test/device",
        expiresInSeconds: 600,
      });
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        interaction.signal?.addEventListener("abort", () => reject(interaction.signal?.reason), { once: true });
      });
    };
    return { login, finish: () => finish() };
  };

  it("shows a device code and connects once the person has entered it", async () => {
    const fake = deviceLogin();
    const signIns = new SignIns(fake.login);
    let connected = false;
    const begin = await signIns.begin("u1", "openai-codex", async () => {
      connected = true;
    });
    expect(begin).toMatchObject({ mode: "device-code", userCode: "WXYZ-0000", expiresInSeconds: 600 });
    expect(signIns.status("u1", begin.loginId)).toEqual({ status: "pending" });
    expect(signIns.status("someone-else", begin.loginId)).toMatchObject({ status: "error" });
    fake.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connected).toBe(true);
    expect(signIns.status("u1", begin.loginId)).toEqual({ status: "connected" });
  });

  it("waits for a pasted code after a sign-in link, and cancels cleanly", async () => {
    const codes: string[] = [];
    const signIns = new SignIns(async (_user, _provider, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://claude.example/authorize" });
      codes.push(await interaction.prompt({ type: "manual_code", message: "Paste the code" }));
    });
    const begin = await signIns.begin("u1", "anthropic", async () => {});
    expect(begin).toMatchObject({ mode: "auth-url", verificationUri: "https://claude.example/authorize" });
    expect(() => signIns.submit("u1", begin.loginId, "  ")).toThrow(/Paste/);
    signIns.submit("u1", begin.loginId, " code#state ");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(codes).toEqual(["code#state"]);
    expect(signIns.status("u1", begin.loginId)).toEqual({ status: "connected" });

    const waiting = await signIns.begin("u1", "anthropic", async () => {});
    signIns.cancel("u1", waiting.loginId);
    expect(signIns.status("u1", waiting.loginId)).toMatchObject({ status: "error" });
  });

  it("refuses providers without in-app sign-in and replaces an older attempt", async () => {
    const fake = deviceLogin();
    const signIns = new SignIns(fake.login);
    await expect(signIns.begin("u1", "openai", async () => {})).rejects.toThrow(/only available/);
    const first = await signIns.begin("u1", "xai", async () => {});
    const second = await signIns.begin("u1", "xai", async () => {});
    expect(signIns.status("u1", first.loginId)).toMatchObject({ status: "error" });
    expect(signIns.status("u1", second.loginId)).toEqual({ status: "pending" });
    signIns.close();
  });
});

describe("your own server", () => {
  it("finds the server's models and reports a rejected key without echoing it", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return json({ data: [{ id: "qwen3:8b" }, { id: "models/llama3" }, { id: "qwen3:8b" }] });
    }) as typeof fetch;
    expect(await listModels({ baseUrl: "http://127.0.0.1:11434/v1/", apiKey: "k" }, fetchImpl)).toEqual([
      "llama3",
      "qwen3:8b",
    ]);
    expect(seen).toEqual(["Bearer k"]);
    const denied = (async () => json({ error: "bad key" }, 401)) as typeof fetch;
    const failure = listModels({ baseUrl: "https://x.test/v1", apiKey: "super-secret" }, denied);
    await expect(failure).rejects.toThrow("The API key was rejected");
  });
});

describe("demo model", () => {
  it("fans a supervisor's task out to the team, then reports", async () => {
    const provider = demoProvider(0);
    const tools = [
      {
        name: "delegate",
        description: "",
        parameters: { properties: { bot: { enum: ["scout", "writer", "publisher"] } } },
      },
    ];
    const first = await provider.complete({ messages: [{ role: "user", content: "Plan" }], tools, signal: signal() });
    expect(first.toolCalls.map((c) => JSON.parse(c.arguments).bot)).toEqual(["scout", "writer"]);
    const second = await provider.complete({
      messages: [
        { role: "user", content: "Plan" },
        { role: "tool", toolCallId: "1", name: "delegate", content: "Scout reports:\nok" },
      ],
      tools,
      signal: signal(),
    });
    expect(second).toEqual({ content: "The team reported back (demo model):\n- Scout reports: ok", toolCalls: [] });
  });
});
