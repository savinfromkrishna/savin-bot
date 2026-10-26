import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dayOf, habitCadence, habitStats, markHabit, profileStrength } from "../../shared/coach.ts";
import type { Habit } from "../../shared/contracts.ts";
import { Candidate, Day, HabitInput, HabitPatch } from "../../shared/contracts.ts";
import type { Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

/** Profile fields a bot may fill in. The daily limit and the extra sites stay the person's to set. */
const fields = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  goals: "Looking for",
  summary: "Experience and skills",
  links: "Links",
  answers: "Ready answers",
} as const;
type Field = keyof typeof fields;
/** Fields that hold one value, where adding means replacing. */
const single = new Set<Field>(["name", "email", "phone", "location"]);

/** At most this many habits are active at once, so each one gets real attention. */
export const MAX_ACTIVE_HABITS = 7;

export function newHabit(input: HabitInput): Habit {
  return {
    ...input,
    target: input.cadence === "daily" ? 1 : input.target,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    active: true,
    done: [],
  };
}

/** A habit with a change applied; a daily habit is always once a day. */
export function changedHabit(habit: Habit, change: HabitPatch): Habit {
  const cadence = change.cadence ?? habit.cadence;
  return { ...habit, ...change, cadence, target: cadence === "daily" ? 1 : (change.target ?? habit.target) };
}

/** One habit as a bot reads it: its id, rhythm and how it is going. */
export function habitLine(habit: Habit, today = dayOf()) {
  const stats = habitStats(habit, today);
  const unit = habit.cadence === "daily" ? "day" : "week";
  return [
    `${habit.id}: ${habit.title} (${habitCadence(habit)})`,
    `streak ${stats.streak} ${unit}${stats.streak === 1 ? "" : "s"}`,
    habit.cadence === "daily"
      ? stats.doneToday
        ? "done today"
        : "not done today"
      : `${stats.thisWeek} of ${habit.target} this week`,
    ...(habit.why ? [`why: ${habit.why}`] : []),
  ].join(" · ");
}

export type CoachStore = {
  candidate: () => Candidate;
  saveCandidate: (candidate: Candidate) => Promise<void>;
  habits: () => Habit[];
  saveHabits: (habits: Habit[]) => Promise<void>;
};

/**
 * What the lead bot of a job search space coaches with: it saves what the person tells it to the profile
 * the whole team applies with, and keeps the habits they agreed on.
 */
export function coachTools(store: CoachStore): Tool[] {
  const missing = () => {
    const { score, gaps } = profileStrength(store.candidate());
    return `Profile ${score}% complete.${gaps.length ? ` Still missing: ${gaps.map((gap) => gap.label).join(", ")}.` : ""}`;
  };
  const habit = (id: string) => store.habits().find((candidate) => candidate.id === id);
  const noHabit = (id: string) => ({ text: `No habit has the id ${id}. habit_list shows them.` });

  return [
    defineTool({
      name: "candidate_update",
      group: "coach",
      description:
        "Save facts about the person to the candidate profile the whole team applies with. Only what the person told you in their own messages or what their résumé says; never guess or embellish. add puts the text on a new line under what is there; replace rewrites the field.",
      input: z.object({
        changes: z
          .array(
            z.object({
              field: z.enum(Object.keys(fields) as [Field, ...Field[]]),
              text: z.string().trim().min(1).max(8000),
              mode: z.enum(["add", "replace"]).default("add"),
            }),
          )
          .min(1)
          .max(10),
      }),
      async run({ changes }) {
        const next: Candidate = { ...store.candidate() };
        for (const change of changes) {
          const current = next[change.field];
          next[change.field] =
            change.mode === "replace" || single.has(change.field) || !current
              ? change.text
              : `${current}\n${change.text}`;
        }
        const checked = Candidate.safeParse(next);
        if (!checked.success) {
          const field = checked.error.issues[0]?.path[0] as Field | undefined;
          return {
            text: `${field ? fields[field] : "The profile"} would be too long. Rewrite it shorter with mode replace.`,
          };
        }
        await store.saveCandidate(checked.data);
        const saved = [...new Set(changes.map((change) => fields[change.field]))].join(", ");
        return { text: `Saved to the profile: ${saved}. ${missing()}` };
      },
    }),
    defineTool({
      name: "habit_list",
      group: "coach",
      readOnly: true,
      description: "The person's habits with their ids, streaks and progress today and this week.",
      input: z.object({}),
      async run() {
        const today = dayOf();
        const active = store.habits().filter((candidate) => candidate.active);
        const paused = store.habits().filter((candidate) => !candidate.active);
        if (!active.length && !paused.length) return { text: "No habits yet." };
        return {
          text: [
            ...active.map((candidate) => `- ${habitLine(candidate, today)}`),
            ...paused.map((candidate) => `- (paused) ${candidate.id}: ${candidate.title}`),
          ].join("\n"),
        };
      },
    }),
    defineTool({
      name: "habit_set",
      group: "coach",
      description:
        "Add a habit the person agreed to, or change one by its id (title, why, how often, or active false to pause it). Never add one they did not agree to.",
      input: HabitPatch.extend({
        id: z.string().trim().max(40).optional().describe("Leave out to add a new habit"),
      }),
      async run({ id, ...change }) {
        const habits = store.habits();
        const activeCount = habits.filter((candidate) => candidate.active).length;
        if (!id) {
          const input = HabitInput.safeParse(change);
          if (!input.success) return { text: "A new habit needs a title and a cadence (daily or weekly)." };
          if (activeCount >= MAX_ACTIVE_HABITS) {
            return { text: `There are already ${activeCount} active habits. Pause one before adding another.` };
          }
          const created = newHabit(input.data);
          await store.saveHabits([...habits, created]);
          return { text: `Added: ${habitLine(created)}` };
        }
        const existing = habit(id);
        if (!existing) return noHabit(id);
        if (change.active && !existing.active && activeCount >= MAX_ACTIVE_HABITS) {
          return { text: `There are already ${activeCount} active habits. Pause one first.` };
        }
        const updated = changedHabit(existing, change);
        await store.saveHabits(habits.map((candidate) => (candidate.id === id ? updated : candidate)));
        return { text: updated.active ? `Updated: ${habitLine(updated)}` : `Paused: ${updated.title}` };
      },
    }),
    defineTool({
      name: "habit_check",
      group: "coach",
      description:
        "Mark a habit done (or not done) for today or one of the last 7 days, when the person says they did it.",
      input: z.object({
        id: z.string().trim().min(1).max(40),
        day: Day.optional().describe("Defaults to today"),
        done: z.boolean().default(true),
      }),
      async run({ id, day, done }) {
        const existing = habit(id);
        if (!existing) return noHabit(id);
        const today = dayOf();
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const target = day ?? today;
        if (target > today || target < dayOf(weekAgo)) return { text: "Only today and the last 7 days can be marked." };
        const updated = markHabit(existing, target, done);
        await store.saveHabits(store.habits().map((candidate) => (candidate.id === id ? updated : candidate)));
        return { text: habitLine(updated, today) };
      },
    }),
  ];
}
