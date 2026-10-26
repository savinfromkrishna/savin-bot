// Keeps savin Social running in the background: starts the app, starts it again when it stops or stops
// answering, writes its output to data/logs/app.log, and can start it when you sign in to Windows.
//   pnpm app:start | app:stop | app:status | app:autostart | app:no-autostart
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const dataDir = resolve(root, process.env.DATA_DIR ?? "data");
const logFile = join(dataDir, "logs", "app.log");
const lockFile = join(dataDir, "keep-running.json");
const stopFile = join(dataDir, "keep-running.stop");
const addresses = [`http://127.0.0.1:${process.env.PORT ?? 4310}/api/auth/get-session`, "http://localhost:5310/"];
const shortcut = process.env.APPDATA
  ? join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "savin Social.lnk")
  : null;
const windows = process.platform === "win32";

/** How often the app is checked, how many failed checks in a row restart it, and how long a fresh start gets. */
const CHECK_EVERY_MS = 30_000;
const FAILED_CHECKS = 4;
const STARTUP_GRACE_MS = 120_000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

type Lock = { keeper: number; app: number | null; since: string };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const readLock = (): Lock | null => {
  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as Lock;
    // A lock from before the computer last started names processes that are gone; their numbers may now be others'.
    return Date.parse(lock.since) > Date.now() - uptime() * 1000 ? lock : null;
  } catch {
    return null;
  }
};
const alive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** Ends a process and everything it started. */
const killTree = (pid: number | null | undefined) => {
  if (!alive(pid)) return;
  try {
    if (windows) execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    else process.kill(-(pid as number), "SIGTERM");
  } catch {}
};
const answers = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status < 500;
  } catch {
    return false;
  }
};
const note = (text: string) => {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[keep-running ${new Date().toISOString()}] ${text}\n`);
};

/** The keeper itself: runs `pnpm dev` and looks after it until asked to stop. */
async function keep() {
  const current = readLock();
  if (current && current.keeper !== process.pid && alive(current.keeper)) return;
  // An app left behind by a keeper that was ended abruptly still holds the ports.
  if (current) killTree(current.app);
  rmSync(stopFile, { force: true });
  let app: ChildProcess | null = null;
  let startedAt = 0;
  let crashes = 0;
  let failed = 0;
  let stopping = false;
  const save = () =>
    writeFileSync(
      lockFile,
      JSON.stringify({ keeper: process.pid, app: app?.pid ?? null, since: new Date().toISOString() }),
    );

  const launch = () => {
    mkdirSync(dirname(logFile), { recursive: true });
    if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.old`);
    const out = openSync(logFile, "a");
    const started = spawn("pnpm", ["dev"], {
      cwd: root,
      shell: true,
      windowsHide: true,
      detached: !windows,
      stdio: ["ignore", out, out],
    });
    closeSync(out);
    app = started;
    startedAt = Date.now();
    failed = 0;
    save();
    note(`started the app (process ${started.pid})`);
    started.on("exit", (code) => {
      if (app !== started) return;
      app = null;
      save();
      if (stopping) return;
      // Quick failures in a row wait longer each time; a run of two minutes or more starts the count again.
      crashes = Date.now() - startedAt > 120_000 ? 1 : crashes + 1;
      const wait = Math.min(60_000, 2000 * 2 ** (crashes - 1));
      note(`the app stopped (code ${code}); starting it again in ${wait / 1000}s`);
      setTimeout(() => {
        if (!stopping && !app) launch();
      }, wait);
    });
  };

  const stop = () => {
    stopping = true;
    note("stopping");
    killTree(app?.pid);
    rmSync(lockFile, { force: true });
    rmSync(stopFile, { force: true });
    process.exit(0);
  };

  launch();
  setInterval(() => existsSync(stopFile) && stop(), 1000);
  setInterval(async () => {
    if (!app || Date.now() - startedAt < STARTUP_GRACE_MS) return;
    const ok = (await Promise.all(addresses.map(answers))).every(Boolean);
    failed = ok ? 0 : failed + 1;
    if (failed < FAILED_CHECKS) return;
    note(`the app stopped answering for ${(FAILED_CHECKS * CHECK_EVERY_MS) / 60_000} minutes; restarting it`);
    failed = 0;
    crashes = 0;
    killTree(app.pid);
  }, CHECK_EVERY_MS);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
}

/** Starts the keeper in the background, without a window, and returns. */
async function start() {
  const current = readLock();
  if (current && alive(current.keeper)) {
    console.log("savin Social is already running: http://localhost:5310");
    return;
  }
  if ((await Promise.all(addresses.map(answers))).some(Boolean)) {
    console.log("savin Social is already running in another window. Close that window first, then start it again.");
    return;
  }
  const keeper = spawn(process.execPath, ["--import", "tsx", script, "keep"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  keeper.unref();
  console.log(`savin Social is starting in the background: http://localhost:5310 (log: ${logFile})`);
}

async function stop() {
  const current = readLock();
  if (!current || !alive(current.keeper)) {
    if (current) killTree(current.app);
    rmSync(lockFile, { force: true });
    console.log("savin Social is not running in the background.");
    return;
  }
  writeFileSync(stopFile, "");
  for (let waited = 0; waited < 15_000 && alive(current.keeper); waited += 500) await sleep(500);
  killTree(current.app);
  killTree(current.keeper);
  rmSync(lockFile, { force: true });
  rmSync(stopFile, { force: true });
  console.log("savin Social stopped.");
}

async function status() {
  const current = readLock();
  const running = Boolean(current && alive(current.keeper));
  const [api, web] = await Promise.all(addresses.map(answers));
  console.log(
    running ? `Kept running in the background since ${current?.since}.` : "Not kept running in the background.",
  );
  console.log(`App: ${api && web ? "answering at http://localhost:5310" : api || web ? "partly up" : "not answering"}`);
  console.log(`Starts when you sign in: ${shortcut && existsSync(shortcut) ? "yes" : "no"}`);
  if (existsSync(logFile)) {
    console.log(`Log: ${logFile}`);
    console.log(readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-5).join("\n"));
  }
}

/** A shortcut in the Windows Startup folder that starts the keeper when you sign in. */
function autostart(on: boolean) {
  if (!windows || !shortcut) {
    console.log("Starting at sign-in is set up for Windows only.");
    return;
  }
  if (!on) {
    rmSync(shortcut, { force: true });
    console.log("savin Social no longer starts when you sign in.");
    return;
  }
  const quote = (text: string) => text.replaceAll("'", "''");
  const command = [
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut('${quote(shortcut)}')`,
    `$link.TargetPath = '${quote(process.execPath)}'`,
    `$link.Arguments = '--import tsx "${quote(script)}" start'`,
    `$link.WorkingDirectory = '${quote(root)}'`,
    "$link.WindowStyle = 7",
    "$link.Description = 'Starts savin Social in the background'",
    "$link.Save()",
  ].join("; ");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "pipe" });
  } catch {
    // Windows protects the Startup folder from programs run on someone's behalf; their own window may add to it.
    console.log("Windows did not allow adding savin Social to the Startup folder from here.");
    console.log(`Run this in your own PowerShell window: cd "${root}"; pnpm app:autostart`);
    process.exit(1);
  }
  console.log("savin Social now starts in the background when you sign in to Windows.");
}

const command = process.argv[2] ?? "status";
const commands: Record<string, () => unknown> = {
  keep,
  start,
  stop,
  status,
  autostart: () => autostart(true),
  "no-autostart": () => autostart(false),
};
if (!commands[command]) {
  console.log("Use one of: start, stop, status, autostart, no-autostart");
  process.exit(1);
}
await commands[command]();
