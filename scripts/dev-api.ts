// Runs the API, restarts it when server or shared code changes, and starts it again if it stops on its own.
// Node's own --watch also restarts on writes to data/, which would loop forever. Windows also reports
// a file as changed when it is only read (the web dev server reads src/shared on every page load),
// so a restart needs the file's size or modification time to really change.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

const dirs = ["src/server", "src/shared"];
let child: ChildProcess | null = null;
let timer: NodeJS.Timeout | undefined;
let restarting = false;
let again = false;
let shuttingDown = false;
/** Crashes in a row, each soon after starting: the wait before the next start grows with them. */
let crashes = 0;

const signature = (path: string) => {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "gone";
  }
};
const seen = new Map<string, string>();
for (const dir of dirs) {
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (file.endsWith(".ts")) seen.set(join(dir, file), signature(join(dir, file)));
  }
}

const start = () => {
  const startedAt = Date.now();
  const api = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "src/server/main.ts"], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  child = api;
  api.on("exit", (code, signal) => {
    if (child !== api || restarting || shuttingDown) return;
    crashes = Date.now() - startedAt > 60_000 ? 1 : crashes + 1;
    const wait = Math.min(30_000, 1000 * 2 ** (crashes - 1));
    console.log(`The API stopped (${signal ?? `code ${code}`}); starting it again in ${wait / 1000}s`);
    setTimeout(() => {
      if (child === api && !shuttingDown) start();
    }, wait);
  });
};

/** Asks the API to close its browser and exit, then forces it after a moment. */
const stop = (then: () => void) => {
  const running = child;
  if (!running || running.exitCode !== null || running.signalCode !== null) return then();
  running.once("exit", then);
  running.send("shutdown");
  setTimeout(() => running.kill(), 3000).unref();
};

/** One restart at a time: the old API has let go of its port before the new one starts. */
const restart = (reason: string) => {
  if (restarting) {
    again = true;
    return;
  }
  restarting = true;
  console.log(`Restarting the API (${reason})`);
  stop(() => {
    start();
    restarting = false;
    if (again) {
      again = false;
      restart("more changes");
    }
  });
};

for (const dir of dirs) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file?.endsWith(".ts")) return;
    const path = join(dir, file);
    const now = signature(path);
    if (seen.get(path) === now) return;
    seen.set(path, now);
    clearTimeout(timer);
    timer = setTimeout(() => restart(`${file} changed`), 300);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    stop(() => process.exit(0));
  });
}
start();
