import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { AppState, BrowserTab, CommandLog, ControlState, Run, TerminalSession } from "../../shared/contracts.ts";
import { api, spacePath } from "./api.ts";

export type Live = {
  state: AppState | null;
  runs: Record<string, Run>;
  commands: CommandLog[];
  tabs: BrowserTab[];
  terminals: TerminalSession[];
  control: ControlState;
  connected: boolean;
  /** Bumps whenever something in the workspace changes. */
  filesVersion: number;
};

const LiveContext = createContext<Live | null>(null);

export function useLive() {
  const live = useContext(LiveContext);
  if (!live) throw new Error("useLive outside LiveProvider");
  return live;
}

/**
 * Whether something a page shows is really gone: a bot or group created a moment ago may reach
 * the live state just after the page opens, so a missing one gets a short grace period first.
 */
export function useGone(found: boolean) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (found) return;
    const timer = setTimeout(() => setGone(true), 2000);
    return () => clearTimeout(timer);
  }, [found]);
  return !found && gone;
}

/** Only used below the loading gate, where the state has arrived. */
export function useAppState() {
  const { state } = useLive();
  if (!state) throw new Error("State not loaded");
  return state;
}

const sessionStart = new Date().toISOString();

function speak(text: string, voice: string | null) {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text.replace(/[*_#`>|-]/g, " ").slice(0, 3000));
  const match = voice ? speechSynthesis.getVoices().find((candidate) => candidate.name === voice) : undefined;
  if (match) utterance.voice = match;
  speechSynthesis.speak(utterance);
}

function notify(title: string, body: string) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  new Notification(title, { body: body.slice(0, 160) });
}

/** Configuration, runs and the computer's live feeds, kept current over server-sent events. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>({
    state: null,
    runs: {},
    commands: [],
    tabs: [],
    terminals: [],
    control: {},
    connected: true,
    filesVersion: 0,
  });
  const stateRef = useRef<AppState | null>(null);
  const statuses = useRef(new Map<string, Run["status"]>());

  useEffect(() => {
    const source = new EventSource(spacePath("/events"));
    const update = (change: (current: Live) => Partial<Live>) =>
      setLive((current) => ({ ...current, ...change(current) }));

    const loadAll = () => {
      void api<Run[]>("GET", "/runs")
        .then((list) => {
          for (const run of list) statuses.current.set(run.id, run.status);
          update((current) => ({ runs: { ...current.runs, ...Object.fromEntries(list.map((run) => [run.id, run])) } }));
        })
        .catch(() => {});
      void api<CommandLog[]>("GET", "/commands")
        .then((commands) => update(() => ({ commands })))
        .catch(() => {});
      void api<BrowserTab[]>("GET", "/browser/tabs")
        .then((tabs) => update(() => ({ tabs })))
        .catch(() => {});
      void api<TerminalSession[]>("GET", "/terminals")
        .then((terminals) => update(() => ({ terminals })))
        .catch(() => {});
    };

    const onRun = (run: Run) => {
      const previous = statuses.current.get(run.id);
      statuses.current.set(run.id, run.status);
      const bot = stateRef.current?.bots.find((candidate) => candidate.id === run.botId);
      if (bot && run.parentRunId === null && previous && previous !== run.status && run.startedAt >= sessionStart) {
        if (run.status === "succeeded") {
          if (bot.notifications) notify(`${bot.name} finished`, run.result ?? "");
          if (bot.readAloud && run.result) speak(run.result, bot.voice);
        } else if (run.status === "waiting" && bot.notifications) notify(`${bot.name} needs you`, run.task);
        else if (run.status === "failed" && bot.notifications) notify(`${bot.name} couldn't finish`, run.error ?? "");
      }
      update((current) => ({ runs: { ...current.runs, [run.id]: run } }));
    };

    source.addEventListener("open", () => {
      update(() => ({ connected: true }));
      loadAll();
    });
    source.addEventListener("error", () => update(() => ({ connected: false })));
    source.addEventListener("state", (event) => {
      const state: AppState = JSON.parse(event.data);
      stateRef.current = state;
      update(() => ({ state }));
    });
    source.addEventListener("run", (event) => onRun(JSON.parse(event.data)));
    source.addEventListener("command", (event) => {
      const command: CommandLog = JSON.parse(event.data);
      update((current) => ({
        commands: current.commands.some((entry) => entry.id === command.id)
          ? current.commands.map((entry) => (entry.id === command.id ? command : entry))
          : [...current.commands.slice(-199), command],
      }));
    });
    source.addEventListener("browser", (event) => update(() => ({ tabs: JSON.parse(event.data) })));
    source.addEventListener("terminals", (event) => update(() => ({ terminals: JSON.parse(event.data) })));
    source.addEventListener("control", (event) => update(() => ({ control: JSON.parse(event.data) })));
    source.addEventListener("files", () => update((current) => ({ filesVersion: current.filesVersion + 1 })));
    return () => source.close();
  }, []);

  // Appearance follows the saved preference; "system" leaves it to the operating system.
  const theme = live.state?.preferences.theme;
  useEffect(() => {
    if (!theme || theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}
