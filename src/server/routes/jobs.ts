import type { Hono } from "hono";
import { z } from "zod";
import { markHabit } from "../../shared/coach.ts";
import { ApplicationStatus, Candidate, Day, HabitInput, HabitPatch } from "../../shared/contracts.ts";
import type { Store } from "../store.ts";
import type { Browsers } from "../tools/browser.ts";
import { changedHabit, MAX_ACTIVE_HABITS, newHabit } from "../tools/coach.ts";
import { body, HttpError } from "./util.ts";

/** Where a person signs the job search team's browser in. */
export const jobSignIns = [
  "https://www.linkedin.com/login",
  "https://www.naukri.com/nlogin/login",
  "https://secure.indeed.com/auth",
];

/** A job search space's candidate profile, its application tracker and the person's habits. */
export function jobRoutes(
  app: Hono,
  { store, browsers, announce }: { store: Store; browsers: Pick<Browsers, "open">; announce: () => void },
) {
  const update = async (change: Parameters<Store["update"]>[0]) => {
    await store.update(change);
    announce();
  };

  app.put("/api/candidate", async (c) => {
    const candidate = await body(c, Candidate);
    await update((state) => ({ ...state, candidate }));
    return c.json({ saved: true });
  });

  /** Opens the job sites' sign-in pages in the person's own tabs of this space's browser. */
  app.post("/api/candidate/sign-in", async (c) => {
    await browsers.open(jobSignIns);
    return c.json({ opened: true });
  });

  app.patch("/api/applications/:id", async (c) => {
    const id = c.req.param("id");
    const change = await body(c, z.object({ status: ApplicationStatus }));
    if (!store.state.applications.some((application) => application.id === id)) throw new HttpError(404, "Not found");
    const at = new Date().toISOString();
    await update((state) => ({
      ...state,
      applications: state.applications.map((application) =>
        application.id === id
          ? {
              ...application,
              status: change.status,
              updatedAt: at,
              appliedAt: application.appliedAt ?? (change.status === "applied" ? at : null),
            }
          : application,
      ),
    }));
    return c.json({ saved: true });
  });

  app.delete("/api/applications/:id", async (c) => {
    const id = c.req.param("id");
    await update((state) => ({
      ...state,
      applications: state.applications.filter((application) => application.id !== id),
    }));
    return c.json({ removed: true });
  });

  const activeHabits = () => store.state.habits.filter((habit) => habit.active).length;
  const habitOf = (id: string) => {
    const habit = store.state.habits.find((candidate) => candidate.id === id);
    if (!habit) throw new HttpError(404, "Not found");
    return habit;
  };
  const saveHabit = (id: string, change: Parameters<typeof changedHabit>[1] | { day: string; done: boolean }) =>
    update((state) => ({
      ...state,
      habits: state.habits.map((habit) =>
        habit.id !== id
          ? habit
          : "day" in change
            ? markHabit(habit, change.day, change.done)
            : changedHabit(habit, change),
      ),
    }));

  app.post("/api/habits", async (c) => {
    const input = await body(c, HabitInput);
    if (activeHabits() >= MAX_ACTIVE_HABITS) throw new HttpError(400, "Pause a habit before adding another");
    const habit = newHabit(input);
    await update((state) => ({ ...state, habits: [...state.habits, habit] }));
    return c.json({ id: habit.id });
  });

  app.patch("/api/habits/:id", async (c) => {
    const id = c.req.param("id");
    const change = await body(c, HabitPatch);
    const habit = habitOf(id);
    if (change.active && !habit.active && activeHabits() >= MAX_ACTIVE_HABITS) {
      throw new HttpError(400, "Pause a habit before resuming another");
    }
    await saveHabit(id, change);
    return c.json({ saved: true });
  });

  /** Marks a habit done, or not, on one day (the person's own calendar day). */
  app.put("/api/habits/:id/days/:day", async (c) => {
    const id = c.req.param("id");
    const day = Day.safeParse(c.req.param("day"));
    if (!day.success) throw new HttpError(400, "Use a day like 2026-10-23");
    const { done } = await body(c, z.object({ done: z.boolean() }));
    habitOf(id);
    await saveHabit(id, { day: day.data, done });
    return c.json({ saved: true });
  });

  app.delete("/api/habits/:id", async (c) => {
    const id = c.req.param("id");
    await update((state) => ({ ...state, habits: state.habits.filter((habit) => habit.id !== id) }));
    return c.json({ removed: true });
  });
}
