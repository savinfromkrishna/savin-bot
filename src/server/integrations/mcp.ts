import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BotId, ToolInfo } from "../../shared/contracts.ts";
import type { McpServerRecord } from "../store.ts";
import type { Tool } from "../tools/tool.ts";
import { looksReadOnly } from "../tools/tool.ts";

type RemoteTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean };
type Live = {
  revision: string;
  client: Client | null;
  status: "connected" | "connecting" | "error";
  error: string | null;
  tools: RemoteTool[];
};

export type McpSecret = { headerValue?: string; env?: Record<string, string> };

/** JSON Schema keys some model APIs reject; MCP servers often include them. */
const unsupported = new Set(["$schema", "$id", "$comment", "additionalProperties", "examples"]);
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !unsupported.has(key))
      .map(([key, value]) => [key, cleanSchema(value)]),
  );
}

/** Model APIs accept [a-zA-Z0-9_-]{1,64} as a tool name. */
export const mcpToolName = (slug: string, tool: string) =>
  `mcp__${slug}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);

const revisionOf = (record: McpServerRecord) =>
  JSON.stringify([record.transport, record.url, record.command, record.args, record.headerName, record.secret]);

/** Live connections to the MCP servers people added; their tools become bot tools. */
export class McpServers {
  private live = new Map<string, Live>();

  constructor(
    private readonly options: { open: (record: McpServerRecord) => McpSecret; onChange: () => void; cwd: string },
  ) {}

  view(id: string): Pick<Live, "status" | "error"> & { tools: ToolInfo[] } {
    const live = this.live.get(id);
    return {
      status: live?.status ?? "connecting",
      error: live?.error ?? null,
      tools: (live?.tools ?? []).map(({ name, description, readOnly }) => ({ name, description, readOnly })),
    };
  }

  /** Keeps connections in step with the saved servers: new or changed ones reconnect, removed ones close. */
  sync(records: McpServerRecord[]) {
    for (const [id, live] of this.live) {
      if (!records.some((record) => record.id === id)) {
        void live.client?.close().catch(() => {});
        this.live.delete(id);
      }
    }
    for (const record of records) {
      if (this.live.get(record.id)?.revision !== revisionOf(record)) void this.connect(record);
    }
  }

  async connect(record: McpServerRecord) {
    await this.live
      .get(record.id)
      ?.client?.close()
      .catch(() => {});
    const live: Live = { revision: revisionOf(record), client: null, status: "connecting", error: null, tools: [] };
    this.live.set(record.id, live);
    this.options.onChange();
    try {
      const secret = this.options.open(record);
      const headers: Record<string, string> =
        record.headerName && secret.headerValue ? { [record.headerName]: secret.headerValue } : {};
      const transport =
        record.transport === "stdio"
          ? new StdioClientTransport({
              command: record.command ?? "",
              args: record.args,
              env: { ...(process.env as Record<string, string>), ...secret.env },
              cwd: this.options.cwd,
              stderr: "ignore",
            })
          : record.transport === "sse"
            ? new SSEClientTransport(new URL(record.url ?? ""), { requestInit: { headers } })
            : new StreamableHTTPClientTransport(new URL(record.url ?? ""), { requestInit: { headers } });
      const client = new Client({ name: "savin-social", version: "0.2.0" });
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("The server did not answer in 20 seconds")), 20_000),
        ),
      ]);
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: (cleanSchema(tool.inputSchema) as Record<string, unknown>) ?? { type: "object" },
            readOnly: tool.annotations?.readOnlyHint ?? looksReadOnly(tool.name),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (this.live.get(record.id) !== live) return void client.close().catch(() => {});
      Object.assign(live, { client, status: "connected", tools });
    } catch (error) {
      Object.assign(live, { status: "error", error: error instanceof Error ? error.message : String(error) });
    }
    this.options.onChange();
  }

  toolsFor(records: McpServerRecord[], botId: BotId): Tool[] {
    return records.flatMap((record) => {
      const live = this.live.get(record.id);
      if (!record.agents.includes(botId) || live?.status !== "connected" || !live.client) return [];
      const client = live.client;
      return live.tools.map((remote) => ({
        name: mcpToolName(record.slug, remote.name),
        group: record.name,
        connectorId: `mcp:${record.slug}`,
        description: remote.description || remote.name,
        parameters: remote.inputSchema,
        readOnly: remote.readOnly,
        parse: (input: unknown) =>
          input && typeof input === "object" && !Array.isArray(input)
            ? { ok: true as const, value: input as Record<string, unknown> }
            : { ok: false as const, error: "Arguments must be an object" },
        async run(input: Record<string, unknown>) {
          const result = (await client.callTool({ name: remote.name, arguments: input })) as {
            content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string } }[];
            isError?: boolean;
          };
          const parts = result.content ?? [];
          const text = parts
            .map((part) => part.text ?? part.resource?.text ?? (part.type === "image" ? "[image]" : ""))
            .filter(Boolean)
            .join("\n");
          const image = parts.find((part) => part.type === "image" && part.data);
          return {
            text: `${result.isError ? "Error: " : ""}${text || "(no output)"}`,
            ...(image && { image: `data:${image.mimeType ?? "image/png"};base64,${image.data}` }),
          };
        },
      }));
    });
  }

  async closeAll() {
    await Promise.all([...this.live.values()].map((live) => live.client?.close().catch(() => {})));
    this.live.clear();
  }
}
