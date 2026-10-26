// A tiny MCP server over stdio for tests: one read-only tool and one that changes something.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_views",
      description: "Views for a video",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "post.comment",
      description: "Post a comment",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "get_views")
    return { content: [{ type: "text", text: `${args.id}: 1234 views (${process.env.FIXTURE_TOKEN ?? "no token"})` }] };
  return { content: [{ type: "text", text: `posted ${args.text}` }] };
});

await server.connect(new StdioServerTransport());
