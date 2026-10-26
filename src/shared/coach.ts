import type { Candidate, Habit } from "./contracts.ts";

/** What makes a candidate profile strong, weighted to 100, with the question that fills each part in. */
const parts: { label: string; weight: number; question: string; ok: (c: Candidate) => boolean }[] = [
  {
    label: "Target roles",
    weight: 15,
    question: "Which roles, level, places and kind of work do you want next, and what would you never take?",
    ok: (c) => c.goals.length >= 30,
  },
  {
    label: "Experience",
    weight: 15,
    question: "Which jobs and projects have you had: where, for how long, and what did you own?",
    ok: (c) => c.summary.length >= 400,
  },
  {
    label: "Résumé",
    weight: 15,
    question: "Could you upload your résumé in Settings → Candidate?",
    ok: (c) => Boolean(c.resume),
  },
  {
    label: "Results with numbers",
    weight: 10,
    question: "What result are you proudest of, with a number: users, revenue, time saved, speed, team size?",
    ok: (c) =>
      (c.summary.match(/\d+(?:[.,]\d+)?\s*(?:%|x\b|k\b|\+|lakh|crore|million|users|customers|clients|hours|ms\b)/gi)
        ?.length ?? 0) >= 2,
  },
  {
    label: "Name and email",
    weight: 10,
    question: "Which name and email should applications use?",
    ok: (c) => Boolean(c.name && c.email),
  },
  {
    label: "LinkedIn",
    weight: 10,
    question: "What is your LinkedIn profile link?",
    ok: (c) => /linkedin\.com\/in\//i.test(c.links),
  },
  {
    label: "Phone and city",
    weight: 5,
    question: "Which phone number and city should applications show?",
    ok: (c) => Boolean(c.phone && c.location),
  },
  {
    label: "Notice period",
    weight: 5,
    question: "What is your notice period, and how soon could you start?",
    ok: (c) => /notice|join|start/i.test(c.answers),
  },
  {
    label: "Expected salary",
    weight: 5,
    question: "What do you earn now, and what do you expect next?",
    ok: (c) => /salary|ctc|lpa|compensation|pay/i.test(c.answers),
  },
  {
    label: "Work authorization",
    weight: 5,
    question: "Where are you allowed to work, and would you need a visa anywhere?",
    ok: (c) => /authori[sz]|visa|citizen|permit|eligible/i.test(c.answers),
  },
  {
    label: "Relocation",
    weight: 5,
    question: "Would you relocate or travel for work, and where to?",
    ok: (c) => /relocat|remote/i.test(c.answers),
  },
];

/** How complete the profile is, and what is still missing, most useful first. */
export function profileStrength(candidate: Candidate) {
  const gaps = parts.filter((part) => !part.ok(candidate));
  return {
    score: 100 - gaps.reduce((sum, gap) => sum + gap.weight, 0),
    gaps: gaps.map(({ label, question }) => ({ label, question })),
  };
}

/** A local calendar day, YYYY-MM-DD. */
export const dayOf = (date = new Date()) => date.toLocaleDateString("en-CA");

/** Noon keeps the arithmetic clear of daylight-saving changes. */
const shift = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dayOf(date);
};

/** The Monday of a day's week. */
const weekOf = (day: string) => shift(day, -((new Date(`${day}T12:00:00`).getDay() + 6) % 7));

/** Whether a habit was kept today, this week and how many days or weeks in a row. */
export function habitStats(habit: Habit, today = dayOf()) {
  const done = new Set(habit.done);
  const inWeek = (monday: string) =>
    Array.from({ length: 7 }, (_, index) => shift(monday, index)).filter((day) => done.has(day)).length;
  const doneToday = done.has(today);
  const thisWeek = inWeek(weekOf(today));
  let streak = 0;
  if (habit.cadence === "daily") {
    // Today still counts as kept until it is over.
    for (let day = doneToday ? today : shift(today, -1); done.has(day); day = shift(day, -1)) streak++;
  } else {
    let monday = thisWeek >= habit.target ? weekOf(today) : shift(weekOf(today), -7);
    for (; inWeek(monday) >= habit.target; monday = shift(monday, -7)) streak++;
  }
  return {
    doneToday,
    thisWeek,
    streak,
    last7: Array.from({ length: 7 }, (_, index) => {
      const day = shift(today, index - 6);
      return { day, done: done.has(day) };
    }),
  };
}

/** "every day", or "3 times a week". */
export const habitCadence = (habit: Pick<Habit, "cadence" | "target">) =>
  habit.cadence === "daily" ? "every day" : habit.target === 1 ? "once a week" : `${habit.target} times a week`;

/** A habit marked done or not done on a day; only the last 400 days are kept. */
export const markHabit = (habit: Habit, day: string, done: boolean): Habit => ({
  ...habit,
  done: done ? [...new Set([...habit.done, day])].sort().slice(-400) : habit.done.filter((other) => other !== day),
});
