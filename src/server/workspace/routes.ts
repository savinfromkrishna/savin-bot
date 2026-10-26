import { Readable } from "node:stream";
import type { Hono } from "hono";
import { z } from "zod";
import type { Browsers } from "../tools/browser.ts";
import type { Workspace } from "./files.ts";
import { FileError } from "./files.ts";
import type { CommandLogs, Terminals } from "./terminals.ts";

export type WorkspaceDeps = {
  workspace: Workspace;
  terminals: Terminals;
  commands: CommandLogs;
  browser: Pick<Browsers, "tabs" | "closeTab">;
};

const PathBody = z.object({ path: z.string().min(1).max(1000) });

/** Files, terminals, the bots' command log and browser tabs: the computer the bots work on. */
export function workspaceRoutes(app: Hono, { workspace, terminals, commands, browser }: WorkspaceDeps) {
  const json = async <T extends z.ZodType>(request: { json(): Promise<unknown> }, schema: T) => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new FileError(400, z.prettifyError(parsed.error));
    return parsed.data as z.output<T>;
  };

  app.get("/api/files", async (c) => c.json(await workspace.list(c.req.query("path") ?? "")));

  app.get("/api/files/raw", async (c) => {
    const file = await workspace.read(c.req.query("path") ?? "", c.req.header("range"));
    const headers = new Headers({
      "content-type": file.type,
      "accept-ranges": "bytes",
      "content-length": String(file.partial ? file.end - file.start + 1 : file.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    if (file.partial) headers.set("content-range", `bytes ${file.start}-${file.end}/${file.size}`);
    if (c.req.query("download")) {
      headers.set("content-disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
    }
    return new Response(Readable.toWeb(file.stream) as ReadableStream, { status: file.partial ? 206 : 200, headers });
  });

  app.put("/api/files/text", async (c) => {
    const { path, content } = await json(c.req, PathBody.extend({ content: z.string().max(5_000_000) }));
    await workspace.writeText(path, content);
    return c.json({ path });
  });

  app.put("/api/files/upload", async (c) => {
    const path = c.req.query("path");
    const body = c.req.raw.body;
    if (!path || !body) throw new FileError(400, "Missing file");
    return c.json({ path: await workspace.upload(path, body) }, 201);
  });

  app.post("/api/files/mkdir", async (c) => {
    const { path } = await json(c.req, PathBody);
    await workspace.mkdir(path);
    return c.json({ path }, 201);
  });

  app.post("/api/files/move", async (c) => {
    const { from, to } = await json(c.req, z.object({ from: z.string().min(1), to: z.string().min(1) }));
    await workspace.move(from, to);
    return c.json({ path: to });
  });

  app.delete("/api/files", async (c) => {
    await workspace.remove(c.req.query("path") ?? "");
    return c.json({ deleted: true });
  });

  app.get("/api/terminals", (c) => c.json(terminals.list()));

  app.post("/api/terminals", async (c) => {
    const { cols, rows } = await json(
      c.req,
      z.object({ cols: z.number().int().optional(), rows: z.number().int().optional() }),
    );
    return c.json({ id: terminals.create(cols, rows) }, 201);
  });

  app.delete("/api/terminals/:id", (c) => c.json({ closed: terminals.kill(c.req.param("id")) }));

  app.get("/api/commands", (c) => c.json(commands.list()));

  app.get("/api/browser/tabs", async (c) => c.json(await browser.tabs()));

  app.delete("/api/browser/tabs/:key", async (c) => {
    await browser.closeTab(c.req.param("key"));
    return c.json({ closed: true });
  });
}
