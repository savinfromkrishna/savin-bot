import { useEffect, useState } from "react";
import type { AppState, ModelChoice, ModelProviderView, Thinking } from "../../shared/contracts.ts";
import { COMPATIBLE, DEMO } from "../../shared/providers.ts";
import { api } from "./api.ts";

let catalogRequest: Promise<ModelProviderView[]> | null = null;

/** Every provider Settings → Models offers, loaded once. */
export function useCatalog() {
  const [catalog, setCatalog] = useState<ModelProviderView[] | null>(null);
  useEffect(() => {
    catalogRequest ??= api<ModelProviderView[]>("GET", "/models/catalog");
    catalogRequest.then(setCatalog).catch(() => {
      catalogRequest = null;
    });
  }, []);
  return catalog;
}

export const choiceKey = (choice: ModelChoice | null) => (choice ? `${choice.providerId}::${choice.model}` : "");
export const fromKey = (key: string): ModelChoice | null => {
  if (!key) return null;
  const [providerId = "", model = ""] = key.split("::");
  return { providerId, model };
};

/** The models of every connected provider, for model pickers. */
export function connectedModels(models: AppState["models"], catalog: ModelProviderView[] | null) {
  return models.connections.flatMap((connection) => {
    const ids =
      connection.provider === COMPATIBLE
        ? (connection.server?.models ?? []).map((id) => ({ id, label: id }))
        : (catalog?.find((view) => view.id === connection.provider)?.models ?? []);
    return ids.map((model) => ({
      choice: { providerId: connection.provider, model: model.id },
      key: choiceKey({ providerId: connection.provider, model: model.id }),
      label: `${model.label} · ${connection.label}`,
    }));
  });
}

/** What the active model is called, for the model button and the team map. */
export function activeModelLabel(models: AppState["models"], catalog: ModelProviderView[] | null) {
  const active = models.active;
  if (!active || active.providerId === DEMO.providerId) return "Demo model";
  return (
    catalog?.find((view) => view.id === active.providerId)?.models.find((model) => model.id === active.model)?.label ??
    active.model
  );
}

export const thinkingLabels: Record<Thinking, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
