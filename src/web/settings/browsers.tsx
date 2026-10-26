import { Globe, Plus } from "lucide-react";
import { useState } from "react";
import type { BrowserView } from "../../shared/contracts.ts";
import { platforms } from "../../shared/roster.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { useOverlay } from "../lib/overlay.ts";
import { Button, ErrorText, Input, Select } from "../ui.tsx";
import { SettingsPage } from "./settings-dialog.tsx";

/** Shows a browser's own tab on a bot's computer: the Producer's, or else any bot with a computer. */
function useShowTab() {
  const state = useAppState();
  const overlay = useOverlay();
  const bot =
    state.bots.find((candidate) => candidate.id === "producer") ??
    state.bots.find((candidate) => candidate.computerAccess !== "off") ??
    state.bots[0];
  return (tab: string) => overlay.set({ settings: null, computer: bot?.id ?? null, tab, window: null });
}

function BrowserRow({ browser, show }: { browser: BrowserView; show: (tab: string) => void }) {
  const [name, setName] = useState(browser.name);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = [...(browser.google ? ["Google"] : []), ...browser.signedIn.map((id) => platforms[id].name)];
  const { made, limit, stopped } = browser.videos;
  const change = (patch: Record<string, unknown>) =>
    void api("PATCH", `/browsers/${browser.id}`, patch).catch((failure: Error) => setError(failure.message));
  const open = () => {
    setBusy(true);
    void api<{ tab: string }>("POST", `/browsers/${browser.id}/open`)
      .then(({ tab }) => show(tab))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2 rounded-2xl border border-border p-4">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Browser name"
          className="h-8 max-w-56 border-transparent px-1 font-medium hover:border-border"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => name.trim() && name !== browser.name && change({ name })}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" busy={busy} onClick={open}>
            {browser.google ? "Open" : "Sign in"}
          </Button>
          {browser.main ? null : confirm ? (
            <Button size="sm" variant="danger" onClick={() => void api("DELETE", `/browsers/${browser.id}`)}>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {accounts.length ? `Signed in to ${accounts.join(", ")}` : "Not signed in yet"}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>Gemini videos today:</span>
        <span className="font-medium text-foreground">{made}</span>
        <span>of</span>
        <div className="w-20">
          <Select
            aria-label="Gemini videos a day"
            className="h-7 text-xs"
            value={limit}
            onChange={(event) => change({ videoLimit: Number(event.target.value) })}
          >
            {[...Array(11).keys()].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {stopped ? (
        <p className="text-xs text-warning">
          {stopped}
          <button
            type="button"
            className="ml-2 font-medium text-foreground underline"
            onClick={() => change({ reset: true })}
          >
            Reset
          </button>
        </p>
      ) : null}
      <ErrorText error={error} />
    </div>
  );
}

export function BrowserSettings() {
  const state = useAppState();
  const show = useShowTab();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    setBusy(true);
    void api<{ tab: string }>("POST", "/browsers")
      .then(({ tab }) => show(tab))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsPage
      title="Browsers"
      description="Each browser keeps its own sign-ins. Gemini videos are made in one browser at a time; when one reaches its limit for the day, the next takes over."
    >
      <div className="space-y-3">
        {state.browsers.map((browser) => (
          <BrowserRow key={browser.id} browser={browser} show={show} />
        ))}
      </div>
      <Button busy={busy} onClick={add}>
        <Plus className="size-4" /> Add browser
      </Button>
      <ErrorText error={error} />
    </SettingsPage>
  );
}
