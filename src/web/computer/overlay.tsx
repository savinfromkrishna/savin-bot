import { ArrowLeft, ArrowRight, FolderOpen, Globe, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BotId } from "../../shared/contracts.ts";
import { MAIN_BROWSER, parseTabKey } from "../../shared/ids.ts";
import { api } from "../lib/api.ts";
import { useAppState, useLive } from "../lib/live.tsx";
import { isLive } from "../lib/meta.ts";
import { useOverlay } from "../lib/overlay.ts";
import { AvatarMark } from "../shell/avatar.tsx";
import { Button, cx } from "../ui.tsx";
import { FilesPanel } from "./files-window.tsx";
import { FloatingWindow } from "./floating.tsx";
import type { ScreenHandle, ScreenMeta } from "./screen.tsx";
import { BrowserScreen } from "./screen.tsx";
import { TerminalPanel } from "./terminal-window.tsx";

const control = (botId: BotId, take: boolean) => api("POST", `/computer/${botId}/control`, { take });

export function ComputerOverlay({ botId: raw }: { botId: string }) {
  const state = useAppState();
  const live = useLive();
  const overlay = useOverlay();
  const botId: BotId = state.bots.some((candidate) => candidate.id === raw) ? raw : (state.bots[0]?.id ?? raw);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const screen = useRef<ScreenHandle>(null);
  const [meta, setMeta] = useState<ScreenMeta>({ url: "", title: "" });
  const [address, setAddress] = useState<string | null>(null);

  const names = useMemo(() => Object.fromEntries(state.bots.map((other) => [other.id, other.name])), [state.bots]);
  const browserNames = useMemo(
    () => Object.fromEntries(state.browsers.map((browser) => [browser.id, browser.name])),
    [state.browsers],
  );
  const tabs = live.tabs;
  const [selected, setSelected] = useState<string | null>(overlay.tab);
  // Your own tab opens as soon as it is picked; a bot's tab only once the bot has opened it.
  const current =
    selected && (tabs.some((tab) => tab.key === selected) || parseTabKey(selected).key.startsWith("you"))
      ? selected
      : (tabs.findLast((tab) => parseTabKey(tab.key).key === botId)?.key ?? tabs[0]?.key ?? null);

  const holding = Boolean(live.control[botId]);
  const runs = Object.values(live.runs).filter((run) => run.botId === botId);
  const working = runs.find(isLive);
  const takeover = runs
    .flatMap((run) => run.steps.map((step) => ({ run, step })))
    .find(({ step }) => step.kind === "tool" && step.status === "approval" && step.gate?.kind === "takeover");
  // Your own tabs always take your input; control matters only for the bot's tabs.
  const ownTab = Boolean(current && parseTabKey(current).key.startsWith("you"));
  const interactive = ownTab || (Boolean(current) && holding);
  const windows = overlay.window;

  // The bot waits while you hold its computer, so leaving hands it back.
  const close = () => {
    if (holding) void control(botId, false);
    overlay.set({ computer: null, window: null, tab: null });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) =>
      event.key === "Escape" && !(document.activeElement instanceof HTMLCanvasElement) && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const finishTakeover = async (done: boolean) => {
    if (!takeover) return;
    await api("POST", `/runs/${takeover.run.id}/steps/${takeover.step.id}/decision`, {
      decision: done ? "allow" : "deny",
    });
    if (holding) await control(botId, false);
  };

  const pill = holding
    ? working
      ? `${bot?.name ?? "The bot"} waits until you release control`
      : "You have control"
    : takeover
      ? "Needs you"
      : working
        ? "Working"
        : null;
  const tabLabel = (key: string) => {
    const tab = parseTabKey(key);
    const who = tab.key.startsWith("you") ? "You" : (names[tab.key] ?? tab.key);
    return tab.browser === MAIN_BROWSER ? who : `${who} · ${browserNames[tab.browser] ?? tab.browser}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 md:px-4">
        {bot ? <AvatarMark avatar={bot.avatar} size={30} /> : null}
        <span className="min-w-0 truncate text-[15px] font-semibold">
          {bot ? `${bot.name}’s computer` : "Team computer"}
        </span>
        {pill ? (
          <span
            className={cx(
              "hidden rounded-full px-2.5 py-0.5 text-xs font-medium sm:inline",
              takeover && !holding ? "bg-warning/15 text-warning" : "bg-muted",
            )}
          >
            {pill}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {working ? (
            <Button variant="ghost" onClick={() => void api("POST", `/runs/${working.id}/cancel`)}>
              Stop
            </Button>
          ) : null}
          {takeover ? (
            <>
              {holding ? null : <Button onClick={() => void control(botId, true)}>Take control</Button>}
              <Button variant="ghost" onClick={() => void finishTakeover(false)}>
                Skip
              </Button>
              <Button variant="primary" onClick={() => void finishTakeover(true)}>
                I’m done
              </Button>
            </>
          ) : holding ? (
            <Button variant="primary" onClick={() => void control(botId, false)}>
              Release control
            </Button>
          ) : ownTab ? null : (
            <Button variant="primary" onClick={() => void control(botId, true)}>
              Take control
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={close} aria-label="Close computer">
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/50 px-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSelected(tab.key)}
            title={tab.title || tab.url}
            className={cx(
              "flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs",
              tab.key === current ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:bg-card/60",
            )}
          >
            <Globe className="size-3.5 shrink-0" />
            <span className="truncate">{tabLabel(tab.key)}</span>
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="New tab"
          onClick={() =>
            setSelected(
              `you${tabs.some((tab) => tab.key === "you") ? `-${tabs.filter((tab) => tab.key.startsWith("you")).length + 1}` : ""}`,
            )
          }
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {current ? (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Back"
            disabled={!interactive}
            onClick={() => screen.current?.send({ t: "back" })}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Forward"
            disabled={!interactive}
            onClick={() => screen.current?.send({ t: "forward" })}
          >
            <ArrowRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Reload"
            disabled={!interactive}
            onClick={() => screen.current?.send({ t: "reload" })}
          >
            <RotateCw className="size-4" />
          </Button>
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (address?.trim()) screen.current?.send({ t: "nav", url: address.trim() });
              setAddress(null);
            }}
          >
            <input
              aria-label="Address"
              value={address ?? meta.url}
              readOnly={!interactive}
              onChange={(event) => setAddress(event.target.value)}
              onBlur={() => setAddress(null)}
              className="h-8 w-full rounded-full bg-muted px-4 font-mono text-xs outline-none focus:ring-2 focus:ring-foreground/15"
            />
          </form>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {current ? (
          <BrowserScreen
            key={current}
            tabKey={current}
            interactive={interactive}
            handle={screen}
            onMeta={setMeta}
            className="absolute inset-0"
          />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">The browser opens when a bot uses it.</p>
              <Button onClick={() => setSelected("you")}>Open a tab</Button>
            </div>
          </div>
        )}
        {windows?.includes("terminal") ? (
          <FloatingWindow
            title="Terminal"
            initial="left"
            onClose={() => overlay.set({ window: windows.replace("terminal", "").replace(",", "") || null })}
          >
            <TerminalPanel botId={botId} />
          </FloatingWindow>
        ) : null}
        {windows?.includes("files") ? (
          <FloatingWindow
            title="Files"
            initial="right"
            onClose={() => overlay.set({ window: windows.replace("files", "").replace(",", "") || null })}
          >
            <FilesPanel />
          </FloatingWindow>
        ) : null}
        <nav className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-2xl border border-border bg-card p-1 shadow-xl">
          {(
            [
              { key: "browser", label: "Browser", icon: Globe },
              { key: "terminal", label: "Terminal", icon: SquareTerminal },
              { key: "files", label: "Files", icon: FolderOpen },
            ] as const
          ).map(({ key, label, icon: Icon }) => {
            const open = key === "browser" ? !windows : Boolean(windows?.includes(key));
            return (
              <button
                key={key}
                type="button"
                aria-pressed={open}
                onClick={() => {
                  if (key === "browser") return overlay.set({ window: null });
                  const set = new Set((windows ?? "").split(",").filter(Boolean));
                  if (set.has(key)) set.delete(key);
                  else set.add(key);
                  overlay.set({ window: [...set].join(",") || null });
                }}
                className={cx(
                  "flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium",
                  open
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
