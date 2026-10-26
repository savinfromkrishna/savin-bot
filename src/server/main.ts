import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Accounts } from "./accounts.ts";
import { createAuth, userOf } from "./auth.ts";
import { Secrets } from "./secrets.ts";
import { createServerApp } from "./server.ts";
import { attachSockets } from "./sockets.ts";
import { Spaces } from "./spaces.ts";
import { createComputerDriver } from "./tools/computer.ts";
import { Voice } from "./voice.ts";

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? "data");
const port = Number(env.PORT ?? 4310);
await mkdir(dataDir, { recursive: true });

const secrets = Secrets.open(join(dataDir, "secret.key"));
const accounts = new Accounts(join(dataDir, "accounts"), secrets);
const spaces: Spaces = await Spaces.load(dataDir, {
  secrets,
  accounts,
  computer: createComputerDriver(),
  redirectUri: `http://127.0.0.1:${port}/api/oauth/google/callback`,
  browser: { headless: env.BROWSER_HEADLESS === "1", channel: env.BROWSER_CHANNEL || undefined },
  forgetProvider: (ownerId, provider) => spaces.forgetProvider(ownerId, provider),
  voice: new Voice(join(dataDir, "voice")),
});

// The dev app (5310) and the built one served here (PORT), under either local name.
const origins = [...new Set([5310, port])].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
if (env.WEB_ORIGIN) origins.push(env.WEB_ORIGIN);
const auth = await createAuth({ dataDir, origins, onUserCreated: (user) => spaces.bootstrap(user) });
const app = createServerApp({ auth, spaces });

// In production the same server hosts the built app.
const webDir = resolve("dist/web");
if (env.NODE_ENV === "production" && existsSync(webDir)) {
  const root = relative(process.cwd(), webDir);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

// Local only: the bots can run commands on this machine.
const hostname = "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`savin Social API on http://${hostname}:${port} (data in ${dataDir})`);
});

const headersOf = (request: IncomingMessage) =>
  new Headers(
    Object.entries(request.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]],
    ),
  );
/** A space's sockets open only for the account that owns it. */
const ownsSpace = async (request: IncomingMessage, [spaceId = ""]: string[]) => {
  const user = await userOf(auth, headersOf(request));
  return Boolean(user && spaces.get(spaceId)?.record.ownerId === user.id);
};
attachSockets(server as Server, [
  {
    path: /^\/api\/s\/([\w-]+)\/terminals\/([\w-]+)\/ws$/,
    allow: ownsSpace,
    open: (socket, [spaceId = "", id = ""]) => spaces.get(spaceId)?.socket.terminal(id, socket),
  },
  {
    path: /^\/api\/s\/([\w-]+)\/browser\/([\w.-]+)\/ws$/,
    allow: ownsSpace,
    open: (socket, [spaceId = "", key = ""]) => spaces.get(spaceId)?.socket.browser(key, socket),
  },
]);

let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  // Whatever happens while closing, the process ends; a run in progress picks up again on the next start.
  setTimeout(() => process.exit(code), 10_000).unref();
  accounts.signIns.close();
  server.close();
  await spaces.closeAll().catch((error) => console.error("Closing the spaces failed:", error));
  process.exit(code);
};
// One stray failed promise should not take every space down with it.
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
// After an error nothing caught, the process cannot be trusted: it saves what it can and exits to be restarted.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown(1);
});
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The dev runner asks over IPC, since Windows has no SIGTERM to deliver.
process.on("message", (message) => message === "shutdown" && void shutdown());
