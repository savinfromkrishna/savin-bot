import type { Api, CredentialStore, Model, MutableModels } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelProviderView, SignInMode } from "../../shared/contracts.ts";
import { COMPATIBLE } from "../../shared/providers.ts";
import { type CompatibleServer, compatibleProvider } from "./compatible.ts";

/** In-app subscription sign-in, as in savin: a device code for ChatGPT, Copilot and SuperGrok, a link for Claude. */
export const signIns: Record<string, { mode: SignInMode; label: string; hint: string; billing: string }> = {
  "openai-codex": {
    mode: "device-code",
    label: "Sign in with ChatGPT Plus/Pro",
    hint: "ChatGPT Plus/Pro",
    billing: "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription.",
  },
  "github-copilot": {
    mode: "device-code",
    label: "Sign in with GitHub Copilot",
    hint: "Copilot",
    billing: "Sign in with GitHub Copilot. Uses your Copilot subscription.",
  },
  xai: {
    mode: "device-code",
    label: "Sign in with SuperGrok or X Premium",
    hint: "SuperGrok / key",
    billing: "Sign in with SuperGrok or X Premium, or paste an xAI API key.",
  },
  anthropic: { mode: "auth-url", label: "Sign in with Claude Pro/Max", hint: "Claude Pro/Max / key", billing: "" },
};

/** Cloud accounts and gateways that need more setup than a key or a sign-in. */
const hidden = [
  "amazon-bedrock",
  "azure-openai-responses",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "google-vertex",
];
const names: Record<string, string> = { "openai-codex": "ChatGPT" };
/** Subscription sign-ins first, then the most used keys; the rest keep pi's order. */
const featured = ["openai-codex", "anthropic", "github-copilot", "xai", "google", "openai", "openrouter"];
const rank = (id: string) => (featured.includes(id) ? featured.indexOf(id) : featured.length);
/** The first model of a provider is its default; these replace a first entry that needs a paid plan. */
const preferred: Record<string, string> = { google: "gemini-3.8-flash" };

/** Releases newer than the bundled catalog, added the way savin adds them. */
function supplement(models: MutableModels) {
  const add = (providerId: string, baseId: string, overrides: Partial<Model<Api>> & { id: string }) => {
    const provider = models.getProvider(providerId);
    const base = models.getModel(providerId, baseId);
    if (!provider || !base || models.getModel(providerId, overrides.id)) return;
    const model = { ...base, ...overrides };
    models.setProvider({ ...provider, getModels: () => [model, ...provider.getModels()] });
  };
  const levels = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  add("anthropic", "claude-sonnet-5", { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", thinkingLevelMap: levels });
  add("openai-codex", "gpt-6-sol", { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinkingLevelMap: levels });
  add("google", "gemini-3.8-flash", { id: "gemini-4-argon", name: "Gemini 4 Argon", maxTokens: 32768 });
  add("openrouter", "google/gemini-3.8-flash", { id: "google/gemini-4-argon", name: "Google: Gemini 4 Argon" });
  return models;
}

/** One account's model providers: pi's catalog with the account's credentials, plus its own server if it has one. */
export function accountModels(credentials: CredentialStore, server: CompatibleServer | null): MutableModels {
  const models = supplement(builtinModels({ credentials }));
  for (const id of hidden) models.deleteProvider(id);
  if (server) models.setProvider(compatibleProvider(server));
  return models;
}

let views: ModelProviderView[] | undefined;

/** What Settings → Models lists: every provider, how it connects, and its models. */
export function catalog(): ModelProviderView[] {
  views ??= [
    ...accountModels(undefined as unknown as CredentialStore, null)
      .getProviders()
      .map((provider): ModelProviderView => {
        const signIn = signIns[provider.id];
        const models = provider.getModels().map((model) => ({
          id: model.id,
          label: model.name || model.id,
          thinking: model.reasoning ? getSupportedThinkingLevels(model).filter((level) => level !== "off") : [],
        }));
        const first = models.findIndex((model) => model.id === preferred[provider.id]);
        if (first > 0) models.unshift(...models.splice(first, 1));
        const keyTest = provider.getModels().every((model) => /^openai-(completions|responses)$/.test(model.api));
        return {
          id: provider.id,
          name: names[provider.id] ?? provider.name,
          signIn: signIn ? { mode: signIn.mode, label: signIn.label } : null,
          apiKey: Boolean(provider.auth.apiKey),
          hint: signIn?.hint ?? "API key",
          billing: signIn?.billing ?? `Uses your ${provider.name} API key.`,
          keyTest: keyTest && Boolean(baseUrlOf(provider.getModels())),
          models,
        };
      })
      .filter((view) => view.models.length && (view.apiKey || view.signIn))
      .sort((a, b) => rank(a.id) - rank(b.id)),
    {
      id: COMPATIBLE,
      name: "OpenAI-compatible",
      signIn: null,
      apiKey: true,
      hint: "Custom server",
      billing: "Runs on a server you choose, such as Ollama or LM Studio.",
      keyTest: false,
      models: [],
    },
  ];
  return views;
}

/** The single HTTPS base URL a provider's models share, used to test a key by listing models. */
export function baseUrlOf(models: readonly Model<Api>[]): string | null {
  const urls = new Set(models.map((model) => model.baseUrl.replace(/\/+$/, "")));
  const [url] = urls;
  return urls.size === 1 && url?.startsWith("https://") && !url.includes("{") ? url : null;
}
