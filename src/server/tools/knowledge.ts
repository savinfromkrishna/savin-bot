import { z } from "zod";
import type { BotId, OpenWorkItem } from "../../shared/contracts.ts";
import type { SkillLibrary } from "../library.ts";
import type { Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

export type KnowledgeDeps = {
  saveMemory(botId: BotId, text: string): Promise<void>;
  updateOpenWork(botId: BotId, change: { add: string[]; done: string[] }): Promise<OpenWorkItem[]>;
  skills: SkillLibrary;
};

/** What a bot keeps between tasks: its memory, its open work and the shared skills. */
export function knowledgeTools({ saveMemory, updateOpenWork, skills }: KnowledgeDeps): Tool[] {
  return [
    defineTool({
      name: "memory_save",
      group: "knowledge",
      readOnly: true,
      description:
        "Rewrite your memory: short facts worth knowing in every future task (preferences, accounts, what worked). Replaces the previous memory.",
      input: z.object({ text: z.string().max(20_000) }),
      async run({ text }, context) {
        await saveMemory(context.botId, text);
        return { text: "Memory saved." };
      },
    }),
    defineTool({
      name: "open_work",
      group: "knowledge",
      readOnly: true,
      description: "Track your open work across tasks: add new items and mark finished ones done (by their text).",
      input: z.object({
        add: z.array(z.string().min(1).max(300)).max(20).default([]),
        done: z.array(z.string().min(1).max(300)).max(50).default([]),
      }),
      async run({ add, done }, context) {
        const items = await updateOpenWork(context.botId, { add, done });
        return {
          text: items.length
            ? items.map((item) => `- ${item.text}${item.parked ? " (parked)" : ""}`).join("\n")
            : "Nothing open.",
        };
      },
    }),
    defineTool({
      name: "skill_read",
      group: "knowledge",
      readOnly: true,
      description: "Read a shared skill: step-by-step instructions for a recurring job.",
      input: z.object({ name: z.string().min(1).max(100) }),
      async run({ name }) {
        const skill = await skills.read(name);
        return { text: skill ? skill.content : `No skill named ${name}.` };
      },
    }),
  ];
}
