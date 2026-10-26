import type { ChatMessage, Completion, CompletionRequest, LlmProvider, ToolCall } from "./types.ts";

/**
 * Offline stand-in for a model so the team runs without any vendor or key:
 * supervisors fan work out, workers touch the terminal once, everyone reports back.
 */
export function demoProvider(delayMs = 700): LlmProvider {
  let calls = 0;
  const call = (name: string, input: Record<string, unknown>): ToolCall => ({
    id: `demo_${++calls}`,
    name,
    arguments: JSON.stringify(input),
  });
  return {
    async complete({ messages, tools, signal }: CompletionRequest): Promise<Completion> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      const task = messages.find((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")?.content ?? "";
      const results = messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
      const names = new Set(tools.map((tool) => tool.name));

      if (results.length === 0) {
        const team = (
          tools.find((tool) => tool.name === "delegate")?.parameters as { properties?: { bot?: { enum?: string[] } } }
        )?.properties?.bot?.enum;
        const picks = ["scout", "writer", "editor"].filter((bot) => team?.includes(bot));
        if (picks.length) {
          return {
            content: `Splitting this between ${picks.join(", ")}.`,
            // The request's first paragraph: attached material stays in its file.
            toolCalls: picks.map((bot) =>
              call("delegate", { bot, task: `Your part of: ${(task.split("\n\n")[0] ?? task).slice(0, 300)}` }),
            ),
          };
        }
        if (names.has("terminal_run")) {
          return { content: "", toolCalls: [call("terminal_run", { command: 'echo "workspace ready"' })] };
        }
      }
      const reports = results.filter((result) => result.name === "delegate");
      if (reports.length) {
        return {
          content: [
            "The team reported back (demo model):",
            ...reports.map((r) => `- ${r.content.replace(/\s*\n\s*/g, " ")}`),
          ].join("\n"),
          toolCalls: [],
        };
      }
      const output = results.at(-1)?.content.trim().split("\n").at(-1);
      return { content: output ? `Done in demo mode: ${output}` : "Demo model reply.", toolCalls: [] };
    },
  };
}
