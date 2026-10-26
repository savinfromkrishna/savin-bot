import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/server/scheduler.ts";
import { reply, scripted, setup } from "./helpers.ts";

describe("scheduler", () => {
  it("runs a routine whose time came while the app was off, unless that was long ago", async () => {
    const yesterdayAtSeven = new Date(2026, 9, 24, 19, 0).toISOString();
    const routine = (id: string, change: Record<string, unknown> = {}) => ({
      id,
      name: id,
      botId: "scout" as const,
      instruction: "Post today's carousel",
      schedule: "0 19 * * *",
      active: true,
      model: null,
      lastRunAt: yesterdayAtSeven,
      ...change,
    });
    const { store, runtime } = await setup({
      provider: scripted(() => reply("done")),
      change: (state) => ({
        ...state,
        routines: [routine("daily"), routine("paused", { active: false }), routine("never-ran", { lastRunAt: null })],
      }),
    });
    const scheduler = new Scheduler(store, runtime);
    const fired = () => runtime.list().map((run) => (run.trigger.kind === "routine" ? run.trigger.routineId : null));

    // The next morning is too late for last evening's post.
    scheduler.catchUp(new Date(2026, 9, 26, 9, 0));
    expect(fired()).toEqual([]);

    scheduler.catchUp(new Date(2026, 9, 25, 21, 0));
    expect(fired()).toEqual(["daily"]);
    await runtime.wait(runtime.list()[0]?.id ?? "");
    await store.flush();
    // Having run, it waits for its next time.
    scheduler.catchUp(new Date(2026, 9, 25, 21, 5));
    expect(fired()).toEqual(["daily"]);
  });
});
