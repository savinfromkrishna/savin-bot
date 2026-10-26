import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventBus } from "../src/server/events.ts";
import { attachSockets } from "../src/server/sockets.ts";
import { shell } from "../src/server/tools/terminal.ts";
import { Workspace } from "../src/server/workspace/files.ts";
import { Terminals } from "../src/server/workspace/terminals.ts";

const root = mkdtempSync(join(tmpdir(), "savin-social-workspace-"));
const workspace = new Workspace(root);

const read = async (stream: NodeJS.ReadableStream) => {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
};

describe("workspace files", () => {
  it("lists folders first, writes, reads ranges, moves and deletes", async () => {
    await workspace.writeText("posts/hello.md", "Hello, world");
    await workspace.mkdir("research");
    expect((await workspace.list()).map((entry) => `${entry.type}:${entry.path}`)).toEqual([
      "dir:posts",
      "dir:research",
    ]);
    expect(await workspace.list("posts")).toMatchObject([
      { name: "hello.md", path: "posts/hello.md", type: "file", size: 12 },
    ]);

    const whole = await workspace.read("posts/hello.md");
    expect(await read(whole.stream)).toBe("Hello, world");
    const part = await workspace.read("posts/hello.md", "bytes=7-11");
    expect(part).toMatchObject({ partial: true, start: 7, end: 11, size: 12, type: "text/markdown; charset=utf-8" });
    expect(await read(part.stream)).toBe("world");

    await workspace.move("posts/hello.md", "research/hello.md");
    await expect(workspace.move("research/hello.md", "research/hello.md")).rejects.toThrow(/already exists/);
    await workspace.remove("research");
    expect((await workspace.list()).map((entry) => entry.name)).toEqual(["posts"]);
  });

  it("streams uploads to disk", async () => {
    const body = new Blob(["frame".repeat(1000)]).stream();
    expect(await workspace.upload("inbox/clip.mp4", body)).toBe("inbox/clip.mp4");
    expect((await workspace.list("inbox"))[0]?.size).toBe(5000);
  });

  it("refuses anything outside the workspace, including through a link", async () => {
    await expect(workspace.read("../outside.txt")).rejects.toThrow(/outside the workspace/);
    await expect(workspace.writeText("../../escape.txt", "x")).rejects.toThrow(/outside the workspace/);
    await expect(workspace.remove("")).rejects.toThrow(/cannot be deleted/);
    const outside = mkdtempSync(join(tmpdir(), "savin-social-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    try {
      symlinkSync(outside, join(root, "link"), "junction");
    } catch {
      return; // Creating links needs extra rights on some systems.
    }
    await expect(workspace.read("link/secret.txt")).rejects.toThrow(/outside the workspace/);
  });
});

describe("sockets and terminals", () => {
  const server = createServer();
  const terminals = new Terminals({ cwd: root, shell, events: new EventBus() });
  attachSockets(server, [
    { path: /^\/api\/terminals\/([\w-]+)\/ws$/, open: (socket, [id = ""]) => terminals.attach(id, socket) },
  ]);
  const listening = new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  afterAll(() => {
    terminals.closeAll();
    server.close();
  });

  const connect = async (path: string, origin: string) => {
    const port = await listening;
    return new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
  };

  it("refuses sockets from other websites", async () => {
    const socket = await connect("/api/terminals/x/ws", "https://evil.example");
    const status = await new Promise<number>((resolve) =>
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });

  it("runs an interactive shell in the workspace", async () => {
    const id = terminals.create(80, 24);
    const port = await listening;
    const socket = await connect(`/api/terminals/${id}/ws`, `http://localhost:${port}`);
    let output = "";
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { t: string; d?: string };
      if (message.t === "o") output += message.d;
    });
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(JSON.stringify({ t: "r", cols: 100, rows: 30 }));
    const marker = shell.kind === "powershell" ? "Write-Output ('pty-' + (6*7))" : "echo pty-$((6*7))";
    socket.send(JSON.stringify({ t: "i", d: `${marker}\r` }));
    const deadline = Date.now() + 60_000;
    while (!output.includes("pty-42") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output).toContain("pty-42");
    socket.close();
    expect(terminals.list()).toMatchObject([{ id, title: "Terminal 1", exited: false }]);
    expect(terminals.kill(id)).toBe(true);
  }, 90_000);
});
