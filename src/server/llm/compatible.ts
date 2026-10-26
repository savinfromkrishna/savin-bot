import type { Model, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { COMPATIBLE } from "../../shared/providers.ts";

/** A server you run yourself. Its key, when it needs one, is kept with the account's other credentials. */
export type CompatibleServer = { baseUrl: string; models: string[]; reasoning: boolean };

export const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, "");

export function compatibleModel(id: string, server: CompatibleServer): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: COMPATIBLE,
    baseUrl: server.baseUrl,
    reasoning: server.reasoning,
    // Local servers rarely know the developer role or reasoning_effort; savin sends the same.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: server.reasoning, thinkingFormat: "openai" },
    thinkingLevelMap: { off: "none" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  };
}

export function compatibleProvider(server: CompatibleServer): Provider {
  return createProvider({
    id: COMPATIBLE,
    name: "OpenAI-compatible",
    baseUrl: server.baseUrl,
    auth: {
      apiKey: {
        name: "OpenAI-compatible server",
        // Keyless servers still need a placeholder for the OpenAI client.
        resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || "local" }, source: "Your server" }),
      },
    },
    models: server.models.map((id) => compatibleModel(id, server)),
    api: openAICompletionsApi(),
  });
}

/** "Find models" and "Test API key": the server's model list. */
export async function listModels(
  connection: { baseUrl: string; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchImpl(`${normalizeBaseUrl(connection.baseUrl)}/models`, {
    headers: connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "The API key was rejected"
        : `The server answered ${response.status}`,
    );
  }
  const data = (await response.json()) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
  const ids = (data.data ?? data.models ?? []).map((model) => model.id ?? (model as { name?: string }).name ?? "");
  return [...new Set(ids.filter(Boolean).map((id) => id.replace(/^models\//, "")))].sort();
}
