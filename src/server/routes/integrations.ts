import type { Hono } from "hono";
import { z } from "zod";
import { BotId, ConnectionInput, McpServerInput } from "../../shared/contracts.ts";
import type { Integrations } from "../integrations/service.ts";
import { IntegrationError } from "../integrations/service.ts";
import { body, HttpError } from "./util.ts";

/** The small page Google's sign-in popup lands on; it closes itself. */
export const callbackPage = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0;color:#18181b">
<div style="text-align:center"><p style="font-weight:600">${title}</p><p style="color:#71717a">${message}</p></div>
<script>setTimeout(() => window.close(), 1500)</script></body>`;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function integrationRoutes(app: Hono, { integrations }: { integrations: Integrations }) {
  const guard = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof IntegrationError) throw new HttpError(422, error.message);
      throw error;
    }
  };

  app.get("/api/integrations/catalog", (c) => c.json(integrations.catalog()));

  app.post("/api/connections", async (c) => {
    const input = await body(c, ConnectionInput);
    return c.json(await guard(() => integrations.connect(input)), 201);
  });

  /** Starts Google sign-in; the browser opens the returned URL in a popup. */
  app.post("/api/connections/google", async (c) => {
    const input = await body(
      c,
      z.object({ connectorId: z.string(), agents: z.array(BotId), reconnectId: z.string().optional() }),
    );
    return c.json(await guard(() => integrations.beginGoogle(input.connectorId, input.agents, input.reconnectId)));
  });

  app.get("/api/oauth/google/callback", async (c) => {
    try {
      const label = await integrations.completeGoogle(
        c.req.query("state") ?? "",
        c.req.query("code") ?? null,
        c.req.query("error") ?? null,
      );
      return c.html(callbackPage("Connected", `${escapeHtml(label)} is connected. You can close this window.`));
    } catch (error) {
      return c.html(
        callbackPage("Couldn't connect", escapeHtml(error instanceof Error ? error.message : String(error))),
        400,
      );
    }
  });

  app.patch("/api/connections/:id", async (c) => {
    const change = await body(c, z.object({ label: z.string().max(80).optional(), agents: z.array(BotId).optional() }));
    await guard(() => integrations.update(c.req.param("id"), change));
    return c.json({ saved: true });
  });

  app.delete("/api/connections/:id", async (c) => {
    await integrations.remove(c.req.param("id"));
    return c.json({ deleted: true });
  });

  app.delete("/api/integrations/:connectorId", async (c) => {
    await integrations.uninstall(c.req.param("connectorId"));
    return c.json({ deleted: true });
  });

  app.post("/api/mcp-servers", async (c) => {
    const input = await body(c, McpServerInput);
    return c.json({ id: await guard(() => integrations.addMcpServer(input)) }, 201);
  });

  app.put("/api/mcp-servers/:id", async (c) => {
    const input = await body(c, McpServerInput.partial());
    await guard(() => integrations.updateMcpServer(c.req.param("id"), input));
    return c.json({ saved: true });
  });

  app.delete("/api/mcp-servers/:id", async (c) => {
    await integrations.removeMcpServer(c.req.param("id"));
    return c.json({ deleted: true });
  });

  app.post("/api/mcp-servers/:id/reconnect", (c) => {
    integrations.reconnectMcpServer(c.req.param("id"));
    return c.json({ reconnecting: true });
  });
}
