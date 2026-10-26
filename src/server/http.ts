import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppState, ServerEvent } from "../shared/contracts.ts";
import { PlatformId } from "../shared/contracts.ts";
import { platforms } from "../shared/roster.ts";
import type { Accounts } from "./accounts.ts";
import type { EventBus } from "./events.ts";
import type { Integrations } from "./integrations/service.ts";
import type { SkillLibrary } from "./library.ts";
import { botRoutes } from "./routes/bots.ts";
import { browserRoutes } from "./routes/browsers.ts";
import { groupRoutes } from "./routes/groups.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { modelRoutes } from "./routes/models.ts";
import { runRoutes } from "./routes/runs.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { body, HttpError } from "./routes/util.ts";
import { MAX_AUDIO_BYTES, voiceRoutes } from "./routes/voice.ts";
import type { Runtime } from "./runtime.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";
import type { Browsers } from "./tools/browser.ts";
import type { Voice } from "./voice.ts";
import { FileError } from "./workspace/files.ts";
import type { WorkspaceDeps } from "./workspace/routes.ts";
import { workspaceRoutes } from "./workspace/routes.ts";

export type AppDeps = {
  store: Store;
  runtime: Runtime;
  scheduler: Scheduler;
  events: EventBus;
  integrations: Integrations;
  skills: SkillLibrary;
  browsers: Browsers;
  workspace: Omit<WorkspaceDeps, "browser">;
  accounts: Accounts;
  /** The space's owner: its bots run on this account's model connections. */
  ownerId: string;
  forgetProvider: (provider: string) => Promise<void>;
  state: () => Promise<AppState>;
  /** Voice typing, shared by every space on this computer. */
  voice: Voice;
};

/** Requests whose body is a raw file rather than JSON: workspace uploads and voice recordings. */
const rawUploads = new Set(["/api/files/upload", "/api/voice/transcribe"]);

export const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** The largest JSON body the API reads. */
export const MAX_JSON_BYTES = 1024 * 1024;

/** What each live event carries to the browser. */
const payload = (event: ServerEvent) => {
  switch (event.type) {
    case "state":
      return event.state;
    case "run":
      return event.run;
    case "command":
      return event.command;
    case "browser":
      return event.tabs;
    case "terminals":
      return event.terminals;
    case "control":
      return event.control;
    case "files":
      return {};
  }
};

/** One space's API. The server mounts it under /api/s/{space}/ once the person is signed in and owns it. */
export function createApp(deps: AppDeps) {
  const { store, runtime, scheduler, events, integrations, skills, browsers, workspace, accounts, ownerId, state } =
    deps;
  const app = new Hono();
  const announce = () => void state().then((current) => events.emit({ type: "state", state: current }));

  // The API drives a terminal and a browser, so it only answers this machine's own pages:
  // the host check stops DNS rebinding, and writes must be JSON (or carry a custom header,
  // for raw uploads) so another site's form can never post here without a CORS preflight.
  app.use("/api/*", async (c, next) => {
    if (!localHost.test(c.req.header("host") ?? "")) return c.json({ error: "Forbidden host" }, 403);
    const json = c.req.header("content-type")?.startsWith("application/json");
    const upload = rawUploads.has(c.req.path) && c.req.header("x-savin-upload") === "1";
    if (c.req.method !== "GET" && !json && !upload) return c.json({ error: "Expected JSON" }, 415);
    await next();
  });

  // A request body is JSON a person typed; anything bigger travels as a file upload instead.
  const limit = bodyLimit({
    maxSize: MAX_JSON_BYTES,
    onError: (c) => c.json({ error: "That is too much to send at once. Attach it as a file instead." }, 413),
  });
  const recording = bodyLimit({
    maxSize: MAX_AUDIO_BYTES,
    onError: (c) => c.json({ error: "That recording is too long. Keep voice typing under five minutes." }, 413),
  });
  app.use("/api/*", (c, next) =>
    c.req.path === "/api/files/upload"
      ? next()
      : c.req.path === "/api/voice/transcribe"
        ? recording(c, next)
        : limit(c, next),
  );

  app.onError((error, c) => {
    if (error instanceof HttpError || error instanceof FileError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: z.prettifyError(error) }, 400);
    return c.json({ error: error.message }, 500);
  });

  app.get("/api/state", async (c) => c.json(await state()));

  botRoutes(app, { store, runtime, announce });
  groupRoutes(app, { store, runtime, announce });
  runRoutes(app, { runtime });
  settingsRoutes(app, { store, runtime, scheduler, skills, accounts, ownerId, announce });
  modelRoutes(app, { store, accounts, ownerId, announce, forgetProvider: deps.forgetProvider });
  integrationRoutes(app, { integrations });
  workspaceRoutes(app, { ...workspace, browser: browsers });
  browserRoutes(app, { store, browsers, announce });
  jobRoutes(app, { store, browsers, announce });
  voiceRoutes(app, { voice: deps.voice, store, accounts, ownerId });

  /** Opens sign-in pages in your own tab of the bots' browser: the brand's platforms, or the ones asked for. */
  app.post("/api/browser/open", async (c) => {
    const { platforms: chosen } = await body(c, z.object({ platforms: z.array(PlatformId).max(10).optional() }));
    await browsers.open((chosen ?? store.state.profile.platforms).map((id) => platforms[id].url));
    return c.json({ opened: true });
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      // Coalesce bursts: only the latest version of each run, log entry or state is sent.
      const pending = new Map<string, ServerEvent>();
      let wake = () => {};
      const unsubscribe = events.subscribe((event) => {
        const key = event.type === "run" ? event.run.id : event.type === "command" ? event.command.id : event.type;
        pending.set(key, event);
        wake();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake();
      });
      await stream.writeSSE({ event: "state", data: JSON.stringify(await state()) });
      await stream.writeSSE({ event: "control", data: JSON.stringify(runtime.controlState()) });
      while (!stream.aborted) {
        if (!pending.size) {
          const woken = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 15_000);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          if (stream.aborted) break;
          if (!woken) {
            await stream.writeSSE({ event: "ping", data: "" });
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const batch = [...pending.values()];
        pending.clear();
        for (const event of batch) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(payload(event)) });
        }
      }
      unsubscribe();
    }),
  );

  return { app, announce };
}
