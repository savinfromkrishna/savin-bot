import { describe, expect, it } from "vitest";
import type { StoredState } from "../src/server/store.ts";
import { missingTeam } from "../src/server/store.ts";
import { coachTools } from "../src/server/tools/coach.ts";
import type { Tool, ToolContext } from "../src/server/tools/tool.ts";
import { dayOf, habitStats, markHabit, profileStrength } from "../src/shared/coach.ts";
import type { Candidate, Habit, RunStep } from "../src/shared/contracts.ts";
import { defaultCandidate } from "../src/shared/roster.ts";
import { call, fakeTool, reply, scripted, setup, until } from "./helpers.ts";

type ToolStep = Extract<RunStep, { kind: "tool" }>;

const full: Candidate = {
  ...defaultCandidate,
  name: "Asha Rao",
  email: "asha@example.com",
  phone: "+91 90000 00000",
  location: "Pune",
  goals: "Senior frontend developer roles, React, Pune or remote",
  summary: `Acme · frontend lead · 4 years: rebuilt checkout, conversion up 18%, page load down 40%. ${"Details. ".repeat(50)}`,
  links: "https://www.linkedin.com/in/asha-example",
  answers:
    "Notice period: 30 days. Expected salary: 30 LPA. Work authorization: Indian citizen. Relocation: open to Bengaluru.",
  resume: "profile/asha.pdf",
};

const habit = (change: Partial<Habit> = {}): Habit => ({
  id: "h1",
  title: "Message 2 people",
  why: "Referrals get interviews",
  cadence: "daily",
  target: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  active: true,
  done: [],
  ...change,
});

/** The coaching tools on a profile and habits kept in memory. */
function inMemory(start: { candidate?: Candidate; habits?: Habit[] } = {}) {
  const data = { candidate: start.candidate ?? defaultCandidate, habits: start.habits ?? [] };
  const tools = coachTools({
    candidate: () => data.candidate,
    saveCandidate: async (candidate) => {
      data.candidate = candidate;
    },
    habits: () => data.habits,
    saveHabits: async (habits) => {
      data.habits = habits;
    },
  });
  return { data, tools };
}

function coach(start: { candidate?: Candidate; habits?: Habit[] } = {}) {
  const { data, tools: list } = inMemory(start);
  const tools = new Map<string, Tool>(list.map((tool) => [tool.name, tool]));
  const use = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(name);
    const parsed = tool.parse(input);
    if (!parsed.ok) return `invalid: ${parsed.error}`;
    return (await tool.run(parsed.value, {} as ToolContext)).text;
  };
  return { data, use, tools };
}

describe("profile strength", () => {
  it("starts at 0 with the most useful questions first, and reaches 100 when everything is there", () => {
    const empty = profileStrength(defaultCandidate);
    expect(empty.score).toBe(0);
    expect(empty.gaps.map((gap) => gap.label).slice(0, 3)).toEqual(["Target roles", "Experience", "Résumé"]);
    expect(empty.gaps.every((gap) => gap.question.endsWith("?"))).toBe(true);
    expect(profileStrength(full)).toEqual({ score: 100, gaps: [] });
    expect(profileStrength({ ...full, answers: "Notice period: 30 days." }).gaps.map((gap) => gap.label)).toEqual([
      "Expected salary",
      "Work authorization",
      "Relocation",
    ]);
  });
});

describe("habit streaks", () => {
  it("counts days in a row, and today stays open until it is over", () => {
    const today = "2026-10-23";
    const kept = habit({ done: ["2026-10-20", "2026-10-21", "2026-10-22"] });
    expect(habitStats(kept, today)).toMatchObject({ doneToday: false, streak: 3 });
    expect(habitStats(markHabit(kept, today, true), today)).toMatchObject({ doneToday: true, streak: 4 });
    expect(habitStats(habit({ done: ["2026-10-20"] }), today).streak).toBe(0);
    expect(habitStats(kept, today).last7.map((day) => day.done)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("counts weeks that met a weekly target", () => {
    // 2026-10-23 is a Friday; its week starts on Monday the 19th.
    const weekly = habit({
      cadence: "weekly",
      target: 2,
      done: ["2026-10-06", "2026-10-08", "2026-10-13", "2026-10-15", "2026-10-20"],
    });
    expect(habitStats(weekly, "2026-10-23")).toMatchObject({ thisWeek: 1, streak: 2 });
    expect(habitStats(markHabit(weekly, "2026-10-23", true), "2026-10-23")).toMatchObject({ thisWeek: 2, streak: 3 });
  });

  it("keeps a day once and forgets it when unmarked", () => {
    const marked = markHabit(markHabit(habit(), "2026-10-23", true), "2026-10-23", true);
    expect(marked.done).toEqual(["2026-10-23"]);
    expect(markHabit(marked, "2026-10-23", false).done).toEqual([]);
  });
});

describe("coaching tools", () => {
  it("adds what the person said under the profile, replaces single values, and says what is still missing", async () => {
    const { data, use } = coach({ candidate: { ...defaultCandidate, summary: "Acme · 4 years" } });
    const text = await use("candidate_update", {
      changes: [
        { field: "summary", text: "Rebuilt checkout: conversion up 18%" },
        { field: "phone", text: "+91 90000 00000" },
        { field: "answers", text: "Notice period: 30 days", mode: "add" },
      ],
    });
    expect(data.candidate.summary).toBe("Acme · 4 years\nRebuilt checkout: conversion up 18%");
    expect(data.candidate.phone).toBe("+91 90000 00000");
    expect(data.candidate.answers).toBe("Notice period: 30 days");
    expect(text).toMatch(
      /^Saved to the profile: Experience and skills, Phone, Ready answers\. Profile \d+% complete\./,
    );
    await use("candidate_update", { changes: [{ field: "summary", text: "Short again", mode: "replace" }] });
    expect(data.candidate.summary).toBe("Short again");
  });

  it("never touches the daily limit or the sites the browser may open, and refuses an overlong field", async () => {
    const { data, use } = coach();
    expect(await use("candidate_update", { changes: [{ field: "sites", text: "evil.example" }] })).toMatch(/^invalid/);
    expect(await use("candidate_update", { changes: [{ field: "perDay", text: "50" }] })).toMatch(/^invalid/);
    const long = "x".repeat(800);
    expect(
      await use("candidate_update", {
        changes: [
          { field: "links", text: long },
          { field: "links", text: long },
        ],
      }),
    ).toBe("Links would be too long. Rewrite it shorter with mode replace.");
    expect(data.candidate).toEqual(defaultCandidate);
  });

  it("adds, changes, pauses and marks habits", async () => {
    const { data, use } = coach();
    expect(await use("habit_set", { title: "Apply to 3 roles" })).toBe(
      "A new habit needs a title and a cadence (daily or weekly).",
    );
    expect(await use("habit_set", { title: "Post on LinkedIn", why: "Be seen", cadence: "weekly", target: 2 })).toMatch(
      /^Added: \w+: Post on LinkedIn \(2 times a week\) · streak 0 weeks · 0 of 2 this week · why: Be seen$/,
    );
    const id = data.habits[0]?.id ?? "";
    // A change keeps what it does not name.
    await use("habit_set", { id, title: "Post on LinkedIn about work" });
    expect(data.habits[0]).toMatchObject({ title: "Post on LinkedIn about work", why: "Be seen", target: 2 });
    await use("habit_set", { id, cadence: "daily" });
    expect(data.habits[0]).toMatchObject({ cadence: "daily", target: 1 });
    expect(await use("habit_check", { id })).toMatch(/streak 1 day · done today/);
    expect(await use("habit_check", { id, day: "2020-01-01" })).toBe("Only today and the last 7 days can be marked.");
    expect(await use("habit_check", { id: "nope" })).toBe("No habit has the id nope. habit_list shows them.");
    expect(await use("habit_set", { id, active: false })).toBe("Paused: Post on LinkedIn about work");
    expect(await use("habit_list", {})).toBe(`- (paused) ${id}: Post on LinkedIn about work`);
    expect(data.habits[0]?.done).toEqual([dayOf()]);
  });

  it("keeps at most seven habits active", async () => {
    const { use } = coach({ habits: Array.from({ length: 7 }, (_, index) => habit({ id: `h${index}` })) });
    expect(await use("habit_set", { title: "One more", cadence: "daily" })).toBe(
      "There are already 7 active habits. Pause one before adding another.",
    );
  });
});

describe("the Coordinator as coach", () => {
  const jobs = (state: StoredState): StoredState => ({ ...state, kind: "jobs", bots: missingTeam({}, "jobs") });
  const coachSet = () => inMemory();
  const save = (text: string) => call("candidate_update", { changes: [{ field: "goals", text }] });

  it("gives the lead the coaching tools, its gaps and habits; teammates get none of it", async () => {
    const seen = new Map<string, { tools: string[]; system: string }>();
    const provider = scripted((bot, request, turn) => {
      seen.set(bot, { tools: request.tools.map((tool) => tool.name), system: String(request.messages[0]?.content) });
      if (bot === "Coordinator" && turn === 0) {
        return { content: "", toolCalls: [call("delegate", { bot: "finder", task: "Find roles" })] };
      }
      return reply("ok");
    });
    const { runtime } = await setup({
      provider,
      tools: coachSet().tools,
      change: (state) => ({ ...jobs(state), habits: [habit()] }),
    });
    await runtime.wait(runtime.start("coordinator", "Coach me", { kind: "manual" }).id);
    const lead = seen.get("Coordinator");
    expect(lead?.tools).toEqual(expect.arrayContaining(["candidate_update", "habit_set", "habit_check", "habit_list"]));
    expect(lead?.system).toContain("Profile gaps (the profile is 0% complete; most useful first)\n- Target roles:");
    expect(lead?.system).toContain("Habits (id: title · streak · progress)\n- h1: Message 2 people (every day)");
    expect(lead?.system).toContain("skill_read coaching-questions");
    expect(seen.get("Finder")?.tools.some((name) => name.startsWith("habit_") || name === "candidate_update")).toBe(
      false,
    );
    expect(seen.get("Finder")?.system).not.toContain("Profile gaps");
  });

  it("saves what the person says on its own, but waits for them once the task read a page", async () => {
    const browse = fakeTool("browser_open", "browser", { readOnly: true });
    const provider = scripted((_bot, _request, turn) => {
      if (turn === 0) return { content: "", toolCalls: [save("Frontend roles in Pune")] };
      if (turn === 1) return { content: "", toolCalls: [call("browser_open", {})] };
      if (turn === 2) return { content: "", toolCalls: [save("Whatever the page said")] };
      return reply("done");
    });
    const { data, tools } = coachSet();
    const { runtime } = await setup({ provider, tools: [...tools, browse], change: jobs });
    const run = runtime.start("coordinator", "I want frontend roles in Pune", { kind: "manual" });
    await until(() => run.status === "waiting");
    expect(data.candidate.goals).toBe("Frontend roles in Pune");
    const waiting = run.steps.findLast((step): step is ToolStep => step.kind === "tool" && step.status === "approval");
    expect(waiting?.gate).toMatchObject({
      why: "This task read outside content, so changes to your profile and habits wait for you.",
    });
    runtime.decide(run.id, waiting?.id ?? "", "deny");
    await runtime.wait(run.id);
    expect(data.candidate.goals).toBe("Frontend roles in Pune");
  });

  it("waits too when a teammate it asked read a page", async () => {
    const browse = fakeTool("browser_open", "browser", { readOnly: true });
    const provider = scripted((bot, _request, turn) => {
      if (bot === "Finder") return turn === 0 ? { content: "", toolCalls: [call("browser_open", {})] } : reply("found");
      if (turn === 0) return { content: "", toolCalls: [call("delegate", { bot: "finder", task: "Read my profile" })] };
      if (turn === 1) return { content: "", toolCalls: [save("What the report said")] };
      return reply("done");
    });
    const { data, tools } = coachSet();
    const { runtime } = await setup({ provider, tools: [...tools, browse], change: jobs });
    const run = runtime.start("coordinator", "Review my LinkedIn", { kind: "manual" });
    await until(() => run.status === "waiting");
    expect(data.candidate.goals).toBe("");
    const step = run.steps.find(
      (candidate): candidate is ToolStep => candidate.kind === "tool" && candidate.status === "approval",
    );
    expect(step?.tool).toBe("candidate_update");
    runtime.cancel(run.id);
    await runtime.wait(run.id);
  });
});
