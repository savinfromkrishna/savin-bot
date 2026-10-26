/** Provider-neutral chat contract. Adapters translate it to a vendor wire format. */

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it; validated by the runtime. */
  arguments: string;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] }
  /** `native` is the adapter's own copy of the reply (reasoning signatures and the like), replayed unchanged. */
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; native?: unknown }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type Completion = {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  native?: unknown;
};

export type CompletionRequest = {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** The preferred thinking level; adapters clamp it to what the model supports. */
  thinking?: string;
};

export interface LlmProvider {
  complete(request: CompletionRequest): Promise<Completion>;
}
