import { ReactFlowProvider } from "@xyflow/react";
import { BrainCircuit, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ToolGroup } from "../../shared/contracts.ts";
import { Canvas } from "../canvas/canvas.tsx";
import { useAccount } from "../lib/account.tsx";
import { api } from "../lib/api.ts";
import { useAppState, useLive } from "../lib/live.tsx";
import { activeModelLabel, useCatalog } from "../lib/models.ts";
import { useOverlay } from "../lib/overlay.ts";
import { PageHeader } from "../shell/app-shell.tsx";
import { Composer } from "../thread/composer.tsx";
import { Button, ErrorText } from "../ui.tsx";

export function CanvasPage() {
  const state = useAppState();
  const { me } = useAccount();
  const { runs } = useLive();
  const overlay = useOverlay();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const runList = useMemo(() => Object.values(runs), [runs]);
  const director = state.bots.find((bot) => bot.supervisor === null) ?? state.bots[0];

  const open = (nodeId: string | null) => {
    if (!nodeId) return;
    const [kind, id = ""] = nodeId.split(":");
    if (kind === "bot") navigate(`/app/bots/${id}`);
    else if (nodeId === "trigger:add") overlay.set({ routine: "new" });
    else if (kind === "trigger" && id !== "chat") overlay.set({ routine: id });
    else if (kind === "model") overlay.set({ settings: "models" });
    else if (kind === "tool") {
      const group = id as ToolGroup;
      const bot =
        state.bots.find((candidate) => candidate.computerAccess !== "off" && candidate.tools[group]) ?? director;
      if (!bot) return;
      overlay.set({
        computer: bot.id,
        window: group === "shell" ? "terminal" : group === "files" ? "files" : null,
      });
    } else if (kind === "app") {
      const connection = state.connections.find((candidate) => candidate.id === id);
      overlay.set({ integrations: connection ? connection.connectorId : "mcp" });
    } else if (kind === "platform") {
      const publisher = state.bots.find((bot) => bot.tools.browser && bot.computerAccess !== "off");
      if (!publisher) return;
      void api("POST", "/browser/open");
      overlay.set({ computer: publisher.id, window: null });
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <Button variant="ghost" onClick={() => overlay.set({ settings: "models" })}>
            <BrainCircuit className="size-4" />
            <span className="hidden max-w-48 truncate sm:inline">{activeModelLabel(state.models, catalog)}</span>
          </Button>
        }
      >
        <h1 className="text-[15px] font-semibold">Team map</h1>
        {me.spaces.length > 1 ? (
          <span className="truncate text-[13px] text-muted-foreground">{state.space.name}</span>
        ) : null}
      </PageHeader>
      {state.bots.length ? (
        <div className="relative min-h-0 flex-1">
          <ReactFlowProvider>
            <Canvas state={state} runs={runList} onOpen={open} />
          </ReactFlowProvider>
          {director ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
              <div className="pointer-events-auto w-full max-w-xl">
                <Composer bot={director} runs={runList} compact />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptySpace />
      )}
    </>
  );
}

/** A space without bots: savin's "Create new Bot", or the space's whole team at once. */
function EmptySpace() {
  const overlay = useOverlay();
  const jobs = useAppState().space.kind === "jobs";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="flex flex-col items-center gap-3">
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => overlay.set({ create: "bot" })}>
            <Plus className="size-4" /> Create new Bot
          </Button>
          <Button
            busy={busy}
            onClick={() => {
              setBusy(true);
              api("POST", "/team")
                .catch((failure: Error) => setError(failure.message))
                .finally(() => setBusy(false));
            }}
          >
            <Users className="size-4" /> {jobs ? "Add job search team" : "Add social media team"}
          </Button>
        </div>
        <ErrorText error={error} />
      </div>
    </div>
  );
}
