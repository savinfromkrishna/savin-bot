/** The built-in offline model, always available. */
export const DEMO = { providerId: "demo", model: "demo" } as const;

/** Any server that speaks the OpenAI chat-completions protocol: Ollama, LM Studio, vLLM, ... */
export const COMPATIBLE = "openai-compatible";
