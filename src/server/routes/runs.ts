import type { Hono } from "hono";
import { z } from "zod";
import { RunInput } from "../../shared/contracts.ts";
import type { Runtime } from "../runtime.ts";
import { body, HttpError } from "./util.ts";

export function runRoutes(app: Hono, { runtime }: { runtime: Runtime }) {
  app.get("/api/runs", (c) => c.json(runtime.list().slice(0, 150)));

  app.get("/api/runs/:id", (c) => {
    const run = runtime.get(c.req.param("id"));
    if (!run) throw new HttpError(404, "Not found");
    return c.json(run);
  });

  app.post("/api/runs", async (c) => {
    const input = await body(c, RunInput);
    if (!runtime.bots().some((bot) => bot.id === input.botId)) throw new HttpError(404, "No such bot");
    return c.json(runtime.start(input.botId, input.task, { kind: "manual" }, { attachments: input.attachments }), 201);
  });

  app.post("/api/runs/:id/cancel", (c) => c.json({ cancelled: runtime.cancel(c.req.param("id")) }));

  app.post("/api/runs/:id/steps/:stepId/decision", async (c) => {
    const { decision } = await body(c, z.object({ decision: z.enum(["allow", "always", "deny"]) }));
    if (!runtime.decide(c.req.param("id"), c.req.param("stepId"), decision)) {
      throw new HttpError(404, "Nothing is waiting for that decision");
    }
    return c.json({ decision });
  });
}
