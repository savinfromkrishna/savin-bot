import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Message,
  Model,
  Models,
  ModelThinkingLevel,
  ThinkingLevel,
  Tool,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatMessage, Completion, LlmProvider, ToolSpec } from "./types.ts";

const levels = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * savin's rule: a reasoning model never starts at "off", because some endpoints reject an
 * effort of "none"; it uses the chosen level, or medium. Plain models send no level at all.
 */
export function reasoningFor(model: Model<Api>, preferred?: string): ThinkingLevel | undefined {
  if (!model.reasoning) return undefined;
  const level = clampThinkingLevel(
    model,
    preferred && levels.has(preferred) ? (preferred as ModelThinkingLevel) : "medium",
  );
  return level === "off" ? undefined : level;
}

const noUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function image(dataUrl: string): ImageContent[] {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  return match?.[1] && match[2] ? [{ type: "image", mimeType: match[1], data: match[2] }] : [];
}

const isAssistantMessage = (value: unknown): value is AssistantMessage =>
  typeof value === "object" &&
  value !== null &&
  (value as { role?: unknown }).role === "assistant" &&
  Array.isArray((value as { content?: unknown }).content);

function argumentsOf(text: string): JsonObject {
  try {
    const value: unknown = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
  } catch {
    return {};
  }
}

/** The runtime's transcript in pi's shape. A reply keeps its native form, so reasoning carries over. */
export function toContext(messages: ChatMessage[], tools: ToolSpec[], model: Model<Api>): Context {
  const timestamp = Date.now();
  const system: string[] = [];
  const transcript: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") system.push(message.content);
    else if (message.role === "user") {
      const images = (message.images ?? []).flatMap(image);
      transcript.push({
        role: "user",
        content: images.length ? [{ type: "text", text: message.content }, ...images] : message.content,
        timestamp,
      });
    } else if (message.role === "tool") {
      transcript.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: [{ type: "text", text: message.content }],
        isError: false,
        timestamp,
      });
    } else if (isAssistantMessage(message.native)) transcript.push(message.native);
    else {
      transcript.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: argumentsOf(call.arguments),
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: noUsage,
        stopReason: message.toolCalls.length ? "toolUse" : "stop",
        timestamp,
      });
    }
  }
  return {
    systemPrompt: system.join("\n\n") || undefined,
    messages: transcript,
    tools: tools.map((tool) => ({ ...tool, parameters: tool.parameters as unknown as Tool["parameters"] })),
  };
}

/** One pi model behind the runtime's provider-neutral contract. Auth comes from the account's credentials. */
export function piProvider(models: Models, model: Model<Api>): LlmProvider {
  return {
    async complete({ messages, tools, signal, thinking }): Promise<Completion> {
      const reasoning = reasoningFor(model, thinking);
      const reply = await models.completeSimple(model, toContext(messages, tools, model), {
        signal,
        ...(reasoning && { reasoning }),
      });
      if (reply.stopReason === "aborted") throw signal.reason ?? new Error("Cancelled");
      if (reply.stopReason === "error") throw new Error(reply.errorMessage || "The model request failed");
      return {
        content: reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
        toolCalls: reply.content.flatMap((block) =>
          block.type === "toolCall"
            ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments ?? {}) }]
            : [],
        ),
        usage: {
          inputTokens: reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
          outputTokens: reply.usage.output,
        },
        native: reply,
      };
    },
  };
}
