import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BotId, CommandLog } from "../../shared/contracts.ts";
import { api, socketUrl } from "../lib/api.ts";
import { useLive } from "../lib/live.tsx";
import { Button, cx, Tabs } from "../ui.tsx";

const theme = () => {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--card").trim() || "#ffffff",
    foreground: style.getPropertyValue("--foreground").trim() || "#18181b",
    cursor: style.getPropertyValue("--foreground").trim() || "#18181b",
    selectionBackground: "#7c7c8040",
  };
};

/** An xterm that fills its box and refits as the box changes size. */
function useTerminal(options: { readOnly: boolean; onResize?: (cols: number, rows: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const resize = useRef(options.onResize);
  resize.current = options.onResize;
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace",
      fontSize: 12,
      convertEol: true,
      cursorBlink: !options.readOnly,
      disableStdin: options.readOnly,
      scrollback: 5000,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const refit = () => {
      try {
        fit.fit();
        resize.current?.(term.cols, term.rows);
      } catch {}
    };
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    refit();
    terminal.current = term;
    return () => {
      observer.disconnect();
      term.dispose();
      terminal.current = null;
    };
  }, [options.readOnly]);
  return { box, terminal };
}

/** What the bot did, as a terminal transcript; written incrementally as commands stream. */
function ActivityTerminal({ entries }: { entries: CommandLog[] }) {
  const { box, terminal } = useTerminal({ readOnly: true });
  const written = useRef(new Map<string, { output: number; done: boolean }>());

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    if (!entries.length && !written.current.size) {
      term.write("\x1b[2mNo bot activity yet.\x1b[0m\r\n");
      written.current.set("empty", { output: 0, done: true });
    }
    for (const entry of entries) {
      const seen = written.current.get(entry.id);
      if (!seen) {
        if (written.current.has("empty")) {
          term.reset();
          written.current.delete("empty");
        }
        if (entry.kind === "command") term.write(`\x1b[1m$ ${entry.command}\x1b[0m\r\n`);
        else term.write(`\x1b[2m${entry.kind === "write" ? "✎ Wrote" : "↗ Opened"} ${entry.command}\x1b[0m\r\n`);
      }
      const previous = seen?.output ?? 0;
      if (entry.output.length > previous) term.write(entry.output.slice(previous));
      const done = entry.status !== "running";
      if (done && !seen?.done && entry.kind === "command") {
        term.write(
          `${entry.output.endsWith("\n") || !entry.output ? "" : "\r\n"}\x1b[2m[exit ${entry.exitCode ?? "?"}]\x1b[0m\r\n\r\n`,
        );
      }
      written.current.set(entry.id, { output: entry.output.length, done });
    }
  }, [entries, terminal]);

  return <div ref={box} className="h-full w-full px-2 pt-2" />;
}

/** An interactive shell in the shared workspace, connected over a WebSocket. */
function ShellTerminal({ id }: { id: string }) {
  const socket = useRef<WebSocket | null>(null);
  const { box, terminal } = useTerminal({
    readOnly: false,
    onResize: (cols, rows) => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ t: "r", cols, rows }));
    },
  });

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const ws = new WebSocket(socketUrl(`/terminals/${id}/ws`));
    ws.onopen = () => ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { t: "o"; d: string } | { t: "x"; code: number };
      if (message.t === "o") term.write(message.d);
      else term.write(`\r\n\x1b[2m[closed]\x1b[0m\r\n`);
    };
    const input = term.onData(
      (data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "i", d: data })),
    );
    socket.current = ws;
    term.focus();
    return () => {
      input.dispose();
      ws.close();
    };
  }, [id, terminal]);

  return <div ref={box} className="h-full w-full px-2 pt-2" />;
}

function Shells() {
  const { terminals } = useLive();
  const [selected, setSelected] = useState<string | null>(null);
  const open = terminals.filter((session) => !session.exited || session.id === selected);
  const current = open.find((session) => session.id === selected) ?? open[0];

  const create = async () => {
    const { id } = await api<{ id: string }>("POST", "/terminals", { cols: 100, rows: 30 });
    setSelected(id);
  };

  if (!current) {
    return (
      <div className="grid h-full place-items-center">
        <Button variant="primary" onClick={() => void create()}>
          Open shell
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        {open.map((session) => (
          <span
            key={session.id}
            className={cx(
              "group inline-flex h-7 items-center gap-1 rounded-md pr-1 pl-2.5 text-xs",
              session.id === current.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted",
            )}
          >
            <button type="button" onClick={() => setSelected(session.id)}>
              {session.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${session.title}`}
              className="grid size-5 place-items-center rounded opacity-0 group-hover:opacity-100 hover:bg-input"
              onClick={() => void api("DELETE", `/terminals/${session.id}`)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button variant="ghost" size="icon" className="size-7" aria-label="New shell" onClick={() => void create()}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <ShellTerminal key={current.id} id={current.id} />
      </div>
    </div>
  );
}

export function TerminalPanel({ botId }: { botId: BotId }) {
  const { commands } = useLive();
  const [tab, setTab] = useState<"activity" | "shell">("activity");
  const entries = commands.filter((entry) => entry.botId === botId);
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "activity", label: "Activity" },
            { value: "shell", label: "Shell" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "activity" ? <ActivityTerminal key={botId} entries={entries} /> : <Shells />}
      </div>
    </div>
  );
}
