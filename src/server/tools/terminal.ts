import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { z } from "zod";
import type { CommandLogs } from "../workspace/terminals.ts";
import { defineTool } from "./tool.ts";

const windows = process.platform === "win32";

export type Shell = { name: string; file: string; kind: "posix" | "powershell" };

/** Models write bash best, so Windows uses Git Bash when it is installed and PowerShell otherwise. */
function findShell(): Shell {
  if (!windows) {
    const file = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    return { name: file.endsWith("bash") ? "bash" : "sh", file, kind: "posix" };
  }
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
  ];
  const bash = roots
    .filter(Boolean)
    .map((root) => join(root as string, "Git", "bin", "bash.exe"))
    .find(existsSync);
  return bash
    ? { name: "bash (Git Bash)", file: bash, kind: "posix" }
    : { name: "Windows PowerShell", file: "powershell.exe", kind: "powershell" };
}

export const shell = findShell();
export const shellName = shell.name;

/**
 * Runs the command (passed in RS_COMMAND) as plain text output: parse and runtime errors become
 * readable lines instead of CLIXML, and a native command's own exit code is passed through.
 */
const powershellHost = [
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "try { $rsBlock = [ScriptBlock]::Create($env:RS_COMMAND) } catch { Write-Output $_.Exception.Message; exit 1 }",
  "$rsErrors = $Error.Count",
  '& $rsBlock 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "$_" } else { $_ } } | Out-String -Stream -Width 300',
  "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
  "if ($Error.Count -gt $rsErrors) { exit 1 }",
].join("\n");

export function shellInvocation(command: string, target: Shell = shell) {
  if (target.kind === "powershell") {
    return {
      file: target.file,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(powershellHost, "utf16le").toString("base64"),
      ],
      env: { RS_COMMAND: command },
    };
  }
  return { file: target.file, args: ["-c", command], env: {} };
}

/** Keeps the start and the end of long output, which is where commands put what matters. */
class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(private readonly half: number) {}
  push(chunk: string) {
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    this.tail += chunk;
    if (this.tail.length > this.half) {
      this.dropped += this.tail.length - this.half;
      this.tail = this.tail.slice(-this.half);
    }
  }
  toString() {
    return this.dropped ? `${this.head}\n… ${this.dropped} characters omitted …\n${this.tail}` : this.head + this.tail;
  }
}

function killTree(pid: number) {
  if (windows) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
}

/** The app's own secrets stay out of the commands bots and people run. */
export const childEnv = () => {
  const { LLM_API_KEY: _model, ENCRYPTION_KEY: _encryption, BETTER_AUTH_SECRET: _auth, ...env } = process.env;
  // The bundled ffmpeg is on the PATH, so commands can cut and convert video without installing it.
  if (ffmpegPath) {
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    env[key] = [dirname(ffmpegPath), env[key]].filter(Boolean).join(delimiter);
  }
  return env;
};

export function runCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    maxChars?: number;
    shell?: Shell;
    onOutput?: (chunk: string) => void;
    /** Extra variables, such as a bot's command-variable credentials. */
    env?: Record<string, string>;
  },
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  const { file, args, env } = shellInvocation(command, options.shell);
  const output = new OutputBuffer((options.maxChars ?? 16_000) / 2);
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...childEnv(), ...options.env, ...env },
      windowsHide: true,
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const stop = () => child.pid && child.exitCode === null && killTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => stop();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const onData = (chunk: string) => {
      output.push(chunk);
      options.onOutput?.(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) reject(options.signal.reason);
      else resolve({ exitCode, output: output.toString().trim(), timedOut });
    });
  });
}

/** The Terminal skill; with a log, every command also streams to the Terminal view. */
export const terminalTools = (logs?: CommandLogs) => [
  defineTool({
    name: "terminal_run",
    group: "shell",
    description: `Run a ${shellName} command in the shared workspace folder and return its output. Use it for files, command-line tools such as ffmpeg or yt-dlp, and HTTP APIs.`,
    input: z.object({
      command: z.string().min(1).max(8000),
      timeoutSeconds: z.number().int().min(1).max(1800).optional().describe("Defaults to 120"),
    }),
    async run({ command, timeoutSeconds = 120 }, context) {
      const log = logs?.start(context.runId, context.botId, command);
      try {
        const variables = Object.fromEntries(
          context.credentials.flatMap((credential) =>
            credential.type === "variable" ? [[credential.name, credential.value]] : [],
          ),
        );
        const result = await runCommand(command, {
          cwd: context.workspaceDir,
          timeoutMs: timeoutSeconds * 1000,
          signal: context.signal,
          onOutput: log?.output,
          env: variables,
        });
        log?.end(result.exitCode, result.timedOut || result.exitCode !== 0);
        const status = result.timedOut ? `Timed out after ${timeoutSeconds}s` : `Exit code ${result.exitCode}`;
        return { text: `${status}\n${result.output || "(no output)"}` };
      } catch (error) {
        log?.end(null, true);
        throw error;
      }
    },
  }),
];
