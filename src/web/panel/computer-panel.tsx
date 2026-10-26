import { Cron } from "croner";
import { Maximize2, Play, Plus } from "lucide-react";
import type { Bot } from "../../shared/contracts.ts";
import { parseTabKey } from "../../shared/ids.ts";
import { BrowserScreen } from "../computer/screen.tsx";
import { api } from "../lib/api.ts";
import { useAppState, useLive } from "../lib/live.tsx";
import { isLive } from "../lib/meta.ts";
import { useOverlay } from "../lib/overlay.ts";
import { Button, cx } from "../ui.tsx";

const nextRun = (schedule: string) => {
  try {
    return (
      new Cron(schedule, { paused: true })
        .nextRun()
        ?.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) ?? null
    );
  } catch {
    return null;
  }
};

/** The bot's screen at a glance, and its routines. */
export function ComputerPanel({ bot }: { bot: Bot }) {
  const state = useAppState();
  const live = useLive();
  const overlay = useOverlay();
  const tab = live.tabs.findLast((candidate) => parseTabKey(candidate.key).key === bot.id);
  const working = Object.values(live.runs).find((run) => run.botId === bot.id && isLive(run));
  const status = live.control[bot.id]
    ? "You have control"
    : working
      ? working.status === "waiting"
        ? "Needs you"
        : "Working"
      : "Idle";
  const routines = state.routines.filter((routine) => routine.botId === bot.id);

  return (
    <div className="space-y-6 px-5 py-5">
      <div className="space-y-2">
        <p className={cx("text-[13px]", working?.status === "waiting" ? "text-warning" : "text-muted-foreground")}>
          {status}
        </p>
        <div className="group relative aspect-[16/10] overflow-hidden rounded-2xl border border-border bg-muted">
          {tab ? (
            <BrowserScreen tabKey={tab.key} interactive={false} className="absolute inset-0" />
          ) : (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">Nothing open yet</div>
          )}
          <button
            type="button"
            onClick={() => overlay.set({ computer: bot.id, window: null })}
            className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100 focus:opacity-100"
          >
            <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[13px] font-medium shadow">
              <Maximize2 className="size-3.5" /> Open
            </span>
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{bot.name}’s screen</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Routines</h3>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Create Routine"
            onClick={() => overlay.set({ routine: `new:${bot.id}` })}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        {routines.length ? (
          <ul className="space-y-1">
            {routines.map((routine) => (
              <li key={routine.id} className="group flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-muted">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => overlay.set({ routine: routine.id })}
                >
                  <span className="block truncate text-[13px] font-medium">{routine.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {routine.active ? (nextRun(routine.schedule) ?? routine.schedule) : "Paused"}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 opacity-0 group-hover:opacity-100"
                  aria-label={`Run ${routine.name} now`}
                  onClick={() => void api("POST", `/routines/${routine.id}/run`)}
                >
                  <Play className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None yet</p>
        )}
      </div>
    </div>
  );
}
