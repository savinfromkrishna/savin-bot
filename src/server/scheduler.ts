import { Cron } from "croner";
import type { Runtime } from "./runtime.ts";
import type { Store } from "./store.ts";

export function validCron(expression: string) {
  try {
    new Cron(expression, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

/** How late a routine may still run when its time came while the app was off. */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;

/** Fires active routines on their schedule. A routine never overlaps its own previous run. */
export class Scheduler {
  private jobs: Cron[] = [];

  constructor(
    private readonly store: Store,
    private readonly runtime: Runtime,
    private readonly announce: () => void = () => {},
  ) {}

  sync() {
    this.stop();
    this.jobs = this.store.state.routines
      .filter((routine) => routine.active && validCron(routine.schedule))
      .map((routine) => new Cron(routine.schedule, () => void this.fire(routine.id)));
  }

  /** On start, runs each routine whose time came while the app was off, once, unless that was long ago. */
  catchUp(now = new Date()) {
    for (const routine of this.store.state.routines) {
      if (!routine.active || !routine.lastRunAt || !validCron(routine.schedule)) continue;
      const cron = new Cron(routine.schedule, { paused: true });
      const due = cron.nextRun(new Date(routine.lastRunAt));
      cron.stop();
      if (due && due <= now && now.getTime() - due.getTime() <= CATCH_UP_MS) this.fire(routine.id);
    }
  }

  fire(routineId: string) {
    const routine = this.store.state.routines.find((candidate) => candidate.id === routineId);
    if (!routine) return null;
    const busy = this.runtime
      .list()
      .some(
        (run) =>
          run.trigger.kind === "routine" &&
          run.trigger.routineId === routineId &&
          (run.status === "running" || run.status === "waiting"),
      );
    if (busy) return null;
    const run = this.runtime.start(
      routine.botId,
      routine.instruction,
      { kind: "routine", routineId, name: routine.name },
      { model: routine.model },
    );
    void this.store
      .update((state) => ({
        ...state,
        routines: state.routines.map((candidate) =>
          candidate.id === routineId ? { ...candidate, lastRunAt: run.startedAt } : candidate,
        ),
      }))
      .then(this.announce);
    return run;
  }

  stop() {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }
}
