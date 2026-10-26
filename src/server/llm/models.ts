import type { Models } from "@earendil-works/pi-ai";
import type { ModelChoice, Thinking } from "../../shared/contracts.ts";
import { DEMO } from "../../shared/providers.ts";
import { demoProvider } from "./demo.ts";
import { piProvider } from "./pi.ts";
import type { LlmProvider } from "./types.ts";

export type ModelTarget = { provider: LlmProvider; choice: ModelChoice; label: string };

/** What an account can run: pi's providers with its credentials, and which of them it connected. */
export type ModelAccess = { models: Models; connected: ReadonlySet<string> };

const same = (a: ModelChoice, b: ModelChoice) => a.providerId === b.providerId && a.model === b.model;

/** A provider for one saved choice, or null when that provider is no longer connected. */
export function modelTarget(access: ModelAccess, choice: ModelChoice): ModelTarget | null {
  if (choice.providerId === DEMO.providerId) return { provider: demoProvider(), choice, label: "Demo model" };
  if (!access.connected.has(choice.providerId)) return null;
  const model = access.models.getModel(choice.providerId, choice.model);
  if (!model) return null;
  const provider = access.models.getProvider(choice.providerId);
  return {
    provider: piProvider(access.models, model),
    choice,
    label: `${model.name} (${provider?.name ?? choice.providerId})`,
  };
}

/**
 * The bot's (or routine's) model first, then the space's default, then the backups in order.
 * The offline demo model is only ever the first choice, never a silent fallback.
 */
export function modelChain(
  access: ModelAccess,
  settings: { active: ModelChoice | null; backups: ModelChoice[] },
  override: ModelChoice | null,
): ModelTarget[] {
  const primary = override ?? settings.active ?? DEMO;
  const fallbacks = [...(settings.active ? [settings.active] : []), ...settings.backups].filter(
    (choice) => choice.providerId !== DEMO.providerId,
  );
  const choices = [primary, ...fallbacks].filter(
    (choice, index, all) => all.findIndex((other) => same(other, choice)) === index,
  );
  return choices.flatMap((choice) => modelTarget(access, choice) ?? []);
}

export const thinkingFor = (spaceThinking: Thinking | null, botThinking: Thinking | null) =>
  botThinking ?? spaceThinking ?? undefined;
