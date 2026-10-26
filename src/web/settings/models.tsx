import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModelChoice, ModelProviderView } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { activeModelLabel, choiceKey, connectedModels, thinkingLabels, useCatalog } from "../lib/models.ts";
import { ConnectForm } from "../models/connect-form.tsx";
import { Button, cx, ErrorText, Section, Select, Spinner } from "../ui.tsx";
import { SettingsPage } from "./settings-dialog.tsx";

function Backups({ catalog }: { catalog: ModelProviderView[] | null }) {
  const state = useAppState();
  const [list, setList] = useState<ModelChoice[]>(state.models.backups);
  const [adding, setAdding] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = connectedModels(state.models, catalog);
  const label = (choice: ModelChoice) =>
    options.find((option) => option.key === choiceKey(choice))?.label ?? `${choice.model} · Not connected`;
  const move = (index: number, by: number) => {
    const next = [...list];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + by, 0, item);
    setList(next);
    setSaved(false);
  };
  const changed = JSON.stringify(list) !== JSON.stringify(state.models.backups);
  return (
    <Section title="Backup models">
      <p className="text-xs text-muted-foreground">
        {options.length ? "Tried in order when the active model fails." : "Connect a provider to add backups."}
      </p>
      {list.length ? (
        <ol className="divide-y divide-border rounded-xl border border-border">
          {list.map((choice, index) => (
            <li key={choiceKey(choice)} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <span className="w-4 text-xs text-muted-foreground">{index + 1}</span>
              <span className="flex-1 truncate">{label(choice)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Move down"
                disabled={index === list.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Remove"
                onClick={() => {
                  setList(list.filter((_, other) => other !== index));
                  setSaved(false);
                }}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {options.length ? (
        <div className="flex flex-wrap gap-2">
          <Select
            className="min-w-0 flex-1"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            aria-label="Add connected model"
          >
            <option value="">Select a connected model</option>
            {options
              .filter((option) => !list.some((choice) => choiceKey(choice) === option.key))
              .map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
          </Select>
          <Button
            disabled={!adding || list.length >= 10}
            onClick={() => {
              const option = options.find((candidate) => candidate.key === adding);
              if (option) setList([...list, option.choice]);
              setAdding("");
              setSaved(false);
            }}
          >
            Add
          </Button>
          <Button
            variant="primary"
            disabled={!changed}
            onClick={() =>
              void api("PUT", "/models/backups", { backups: list })
                .then(() => setSaved(true))
                .catch((failure: Error) => setError(failure.message))
            }
          >
            Save backups
          </Button>
        </div>
      ) : null}
      {list.length >= 10 ? <p className="text-xs text-muted-foreground">Maximum of 10 backup models.</p> : null}
      {saved ? <p className="text-xs text-success">Backup models saved.</p> : null}
      <ErrorText error={error} />
    </Section>
  );
}

/** savin's Models settings: the active model, every provider, and how each one connects. */
export function ModelSettings() {
  const state = useAppState();
  const catalog = useCatalog();
  const { connections, active, thinking } = state.models;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(active?.providerId ?? connections[0]?.provider ?? null);
  const [notice, setNotice] = useState<string | null>(null);

  const connectedIds = useMemo(() => new Set(connections.map((entry) => entry.provider)), [connections]);
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (catalog ?? []).filter(
      (provider) =>
        !text ||
        `${provider.id} ${provider.name} ${provider.models.map((model) => model.id).join(" ")}`
          .toLowerCase()
          .includes(text),
    );
  }, [catalog, query]);
  const current = catalog?.find((provider) => provider.id === selected) ?? catalog?.[0];
  const activeProvider = catalog?.find((provider) => provider.id === active?.providerId);

  const row = (provider: ModelProviderView) => {
    const connected = connectedIds.has(provider.id);
    const using = active?.providerId === provider.id;
    return (
      <button
        key={provider.id}
        type="button"
        aria-current={provider.id === current?.id ? "true" : undefined}
        onClick={() => {
          setSelected(provider.id);
          setNotice(null);
        }}
        className={cx(
          "flex w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left last:border-0",
          provider.id === current?.id ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px]">{provider.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {using
              ? activeModelLabel(state.models, catalog)
              : provider.models.length
                ? `${provider.models.length} model${provider.models.length === 1 ? "" : "s"} · ${provider.hint}`
                : provider.hint}
          </span>
        </span>
        {connected && query ? <span className="text-xs text-success">Connected</span> : null}
      </button>
    );
  };
  const heading = (text: string) => (
    <p className="border-b border-border px-3.5 pt-3 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
      {text}
    </p>
  );

  return (
    <SettingsPage title="Models" description="Choose which connected model the team uses.">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <span className="text-xs tracking-wider text-muted-foreground uppercase">Active model</span>
        <span className="font-medium">{activeModelLabel(state.models, catalog)}</span>
        <span className="text-muted-foreground">{activeProvider?.name ?? "Offline"}</span>
        {active ? (
          <span className="text-muted-foreground">Thinking: {thinkingLabels[thinking ?? "medium"]}</span>
        ) : null}
      </p>
      {catalog && current ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
          <div className="flex min-h-0 flex-col gap-3">
            <label className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground">
              <Search className="size-4" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search providers"
                aria-label="Search providers"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
              />
            </label>
            <div className="max-h-[260px] overflow-y-auto rounded-xl border border-border lg:max-h-[520px]">
              {matches.length ? (
                query ? (
                  matches.map(row)
                ) : (
                  <>
                    {connectedIds.size ? heading("Connected") : null}
                    {matches.filter((provider) => connectedIds.has(provider.id)).map(row)}
                    {connectedIds.size ? heading("All providers") : null}
                    {matches.filter((provider) => !connectedIds.has(provider.id)).map(row)}
                  </>
                )
              ) : (
                <p className="px-3.5 py-4 text-[13px] text-muted-foreground">No providers found.</p>
              )}
            </div>
          </div>
          <div className="min-w-0 space-y-8">
            <div className="space-y-4">
              <h3 className="text-[15px] font-semibold">{current.name}</h3>
              {notice ? (
                <p className="text-[13px] text-success" role="status">
                  {notice}
                </p>
              ) : null}
              <ConnectForm key={current.id} provider={current} models={state.models} onDone={setNotice} />
            </div>
            <Backups catalog={catalog} />
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Loading model catalog…
        </p>
      )}
    </SettingsPage>
  );
}
