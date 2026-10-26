import { z } from "zod";
import type { Bot, BotId } from "../../shared/contracts.ts";
import { defineTool } from "./tool.ts";

/** Delegation: hand work to teammates. Built per run because the reachable team changes. */
export const delegateTool = (team: Bot[]) =>
  defineTool({
    name: "delegate",
    group: "team",
    description:
      "Give a teammate a task and wait for their report. Several delegate calls in one turn run in parallel.",
    input: z.object({
      bot: z.enum(team.map((bot) => bot.id) as [BotId, ...BotId[]]),
      task: z
        .string()
        .min(1)
        .max(8000)
        .describe(
          "Goal, inputs, file paths and the expected result. Name long material by its file path; never copy it in.",
        ),
    }),
    run: async ({ bot, task }, context) => ({ text: await context.delegate(bot, task) }),
  });

/** savin's group hand-off: another member answers next in the thread, and it does not come back. */
export const handoffTool = (members: Bot[]) =>
  defineTool({
    name: "handoff_to_bot",
    group: "team",
    description:
      "Pass this group conversation to another member. They answer next in the thread and you do not get it back, so finish your own part first.",
    input: z.object({
      bot: z.enum(members.map((bot) => bot.id) as [BotId, ...BotId[]]),
      note: z.string().min(1).max(4000).describe("What they should do next, with the context they need"),
    }),
    run: async ({ bot, note }, context) => ({ text: await context.handoff(bot, note) }),
  });
