import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";
import type { BotId, CommandLog, TerminalSession } from "../../shared/contracts.ts";
import type { EventBus } from "../events.ts";
import type { Shell } from "../tools/terminal.ts";
import { childEnv } from "../tools/terminal.ts";

const SCROLLBACK = 256 * 1024;

type Session = TerminalSession & { pty: IPty; buffer: string; clients: Set<WebSocket> };

/** Interactive shells for people, in the same workspace the bots use. */
export class Terminals {
  private sessions = new Map<string, Session>();
  private count = 0;

  constructor(private readonly options: { cwd: string; shell: Shell; events: EventBus }) {}

  list(): TerminalSession[] {
    return [...this.sessions.values()].map(({ id, title, createdAt, exited }) => ({ id, title, createdAt, exited }));
  }

  create(cols = 100, rows = 30) {
    const { shell, cwd } = this.options;
    const args = shell.kind === "powershell" ? ["-NoLogo"] : ["--login", "-i"];
    const process = pty.spawn(shell.file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...childEnv(), TERM: "xterm-256color" } as Record<string, string>,
    });
    const session: Session = {
      id: randomUUID(),
      title: `Terminal ${++this.count}`,
      createdAt: new Date().toISOString(),
      exited: false,
      pty: process,
      buffer: "",
      clients: new Set(),
    };
    process.onData((data) => {
      session.buffer = (session.buffer + data).slice(-SCROLLBACK);
      for (const client of session.clients) client.send(JSON.stringify({ t: "o", d: data }));
    });
    process.onExit(({ exitCode }) => {
      session.exited = true;
      for (const client of session.clients) client.send(JSON.stringify({ t: "x", code: exitCode }));
      this.announce();
    });
    this.sessions.set(session.id, session);
    this.announce();
    return session.id;
  }

  /** Connects a browser tab: it gets the scrollback first, then live output. */
  attach(id: string, socket: WebSocket) {
    const session = this.sessions.get(id);
    if (!session) return socket.close(4404, "No such terminal");
    session.clients.add(socket);
    if (session.buffer) socket.send(JSON.stringify({ t: "o", d: session.buffer }));
    if (session.exited) socket.send(JSON.stringify({ t: "x", code: 0 }));
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { t: "i"; d: string } | { t: "r"; cols: number; rows: number };
        if (session.exited) return;
        if (message.t === "i" && typeof message.d === "string") session.pty.write(message.d);
        if (message.t === "r" && message.cols > 0 && message.rows > 0) {
          session.pty.resize(Math.min(500, Math.floor(message.cols)), Math.min(200, Math.floor(message.rows)));
        }
      } catch {}
    });
    socket.on("close", () => session.clients.delete(socket));
  }

  kill(id: string) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!session.exited) session.pty.kill();
    for (const client of session.clients) client.close();
    this.sessions.delete(id);
    this.announce();
    return true;
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private announce() {
    this.options.events.emit({ type: "terminals", terminals: this.list() });
  }
}

/** Recent commands the bots ran, with output streamed while they run. */
export class CommandLogs {
  private logs: CommandLog[] = [];

  constructor(private readonly events: EventBus) {}

  list() {
    return this.logs;
  }

  /** A one-line entry, such as a file a bot wrote or a page it opened. */
  note(runId: string, botId: BotId, kind: "write" | "open", text: string) {
    const now = new Date().toISOString();
    const log: CommandLog = {
      id: randomUUID(),
      runId,
      botId,
      kind,
      command: text,
      output: "",
      status: "done",
      exitCode: null,
      startedAt: now,
      endedAt: now,
    };
    this.logs = [...this.logs.slice(-199), log];
    this.events.emit({ type: "command", command: log });
  }

  start(runId: string, botId: BotId, command: string) {
    const log: CommandLog = {
      id: randomUUID(),
      runId,
      botId,
      kind: "command",
      command,
      output: "",
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.logs = [...this.logs.slice(-199), log];
    this.events.emit({ type: "command", command: log });
    let pending: NodeJS.Timeout | undefined;
    const flush = () => {
      pending = undefined;
      this.events.emit({ type: "command", command: log });
    };
    return {
      output: (chunk: string) => {
        log.output = (log.output + chunk).slice(-64 * 1024);
        pending ??= setTimeout(flush, 120);
      },
      end: (exitCode: number | null, failed = false) => {
        clearTimeout(pending);
        Object.assign(log, { status: failed ? "failed" : "done", exitCode, endedAt: new Date().toISOString() });
        flush();
      },
    };
  }
}
