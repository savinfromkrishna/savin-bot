import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserService, browserTools } from "../src/server/tools/browser.ts";
import type { OpenCredential, Tool, ToolContext } from "../src/server/tools/tool.ts";

// A real headless Chromium against pages served from this process: no network needed.
const pages: Record<string, string> = {
  "/": `<!doctype html><title>Upload studio</title>
<h1>Studio</h1>
<input id="title" placeholder="Title">
<button onclick="document.querySelector('h1').textContent = 'Saved ' + document.getElementById('title').value">Save</button>
<input type="file" id="file" onchange="document.querySelector('h1').textContent = 'Got ' + this.files[0].name">
<my-card></my-card>
<script>
customElements.define('my-card', class extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<button onclick="document.title = \\'shadow clicked\\'">Inside shadow</button>'; }
});
</script>`,
  "/login": `<!doctype html><title>Sign in</title>
<form onsubmit="event.preventDefault(); document.title = 'Welcome ' + this.user.value + (this.pass.value === 'hunter2' ? ' (ok)' : ' (bad)')">
<input name="user" placeholder="Email"><input name="pass" type="password" placeholder="Password"><button>Sign in</button>
</form>`,
};

const installed = existsSync(chromium.executablePath());

describe.skipIf(!installed)("browser skill", () => {
  const server = createServer((request, response) =>
    response.setHeader("content-type", "text/html").end(pages[request.url ?? "/"] ?? ""),
  );
  const workspaceDir = mkdtempSync(join(tmpdir(), "savin-social-browser-"));
  const browser = new BrowserService({
    profileDir: join(workspaceDir, ".profile"),
    headless: true,
    allowPrivateNetwork: true,
  });
  const guarded = new BrowserService({ profileDir: join(workspaceDir, ".guarded"), headless: true });
  const toolsOf = (service: BrowserService) =>
    Object.fromEntries(browserTools(service).map((tool) => [tool.name, tool]));
  const tools = toolsOf(browser);
  const activity: string[] = [];
  let credentials: OpenCredential[] = [];
  const context = (): ToolContext => ({
    runId: "run",
    botId: "publisher",
    signal: new AbortController().signal,
    workspaceDir,
    credentials,
    delegate: async () => "",
    handoff: async () => "",
    requestApproval: async () => true,
    requestTakeover: async () => true,
    waitForControl: async () => {},
    activity: (kind, text) => activity.push(`${kind} ${text}`),
  });
  const use = async (name: string, input: Record<string, unknown> = {}, set: Record<string, Tool> = tools) => {
    const tool = set[name];
    if (!tool) throw new Error(`no tool ${name}`);
    const parsed = tool.parse(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return tool.run(parsed.value, context());
  };
  const refOf = (snapshot: string, label: string) =>
    Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${label}"`).exec(snapshot)?.[1]);
  let url = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all([browser.close(), guarded.close()]);
    server.close();
  });

  it("reads a page as text plus numbered elements, including shadow DOM", async () => {
    const { text } = await use("browser_open", { url: `${url}/` });
    expect(text).toContain("Page: Upload studio");
    expect(text).toMatch(/\[\d+\] input "Title"/);
    expect(text).toMatch(/\[\d+\] button "Save"/);
    expect(text).toMatch(/\[\d+\] button "Inside shadow"/);
    expect(activity).toContain(`open ${url}/`);
  });

  it("types, clicks and uploads by element number", async () => {
    let { text } = await use("browser_snapshot");
    ({ text } = await use("browser_type", { ref: refOf(text, "Title"), text: "Coffee 101" }));
    ({ text } = await use("browser_click", { ref: refOf(text, "Save") }));
    expect(text).toContain("Saved Coffee 101");

    writeFileSync(join(workspaceDir, "clip.mp4"), "fake video");
    const fileRef = Number(/\[(\d+)\] input\[file\]/.exec(text)?.[1]);
    ({ text } = await use("browser_upload", { ref: fileRef, files: ["clip.mp4"] }));
    expect(text).toContain("Got clip.mp4");
    await expect(use("browser_upload", { ref: fileRef, files: ["../escape.txt"] })).rejects.toThrow(
      /outside the workspace/,
    );

    ({ text } = await use("browser_click", { ref: refOf(text, "Inside shadow") }));
    expect(text).toContain("Page: shadow clicked");
  });

  it("signs in with a saved website login without showing the password", async () => {
    let { text } = await use("browser_open", { url: `${url}/login` });
    const refs = { usernameRef: refOf(text, "Email"), passwordRef: refOf(text, "Password") };
    expect((await use("browser_login", refs)).text).toMatch(/No saved website login/);
    credentials = [{ type: "login", domain: "127.0.0.1", username: "ada@example.test", password: "hunter2" }];
    ({ text } = await use("browser_login", { ...refs, submit: true }));
    expect(text).toContain("Page: Welcome ada@example.test (ok)");
    expect(text).not.toContain("hunter2");
  });

  it("returns screenshots as images and refuses non-web URLs", async () => {
    const shot = await use("browser_screenshot");
    expect(shot.image).toMatch(/^data:image\/jpeg;base64,/);
    await expect(use("browser_open", { url: "file:///etc/passwd" })).rejects.toThrow(/Only http and https/);
  });

  it("keeps bots off this machine and its network by default", async () => {
    await expect(use("browser_open", { url: `${url}/` }, toolsOf(guarded))).rejects.toThrow(/blocked/);
  });

  it("knows which platforms the profile is signed in to, with the browser open or closed", async () => {
    const service = new BrowserService({ profileDir: join(workspaceDir, ".signed-in"), headless: true });
    expect(await service.signedIn()).toEqual([]);
    const page = await service.page("you");
    const inADay = Math.floor(Date.now() / 1000) + 86_400;
    await page.context().addCookies([
      { name: "LOGIN_INFO", value: "x", domain: ".youtube.com", path: "/", expires: inADay, secure: true },
      { name: "csrftoken", value: "x", domain: ".instagram.com", path: "/", expires: inADay, secure: true },
    ]);
    expect(await service.signedIn()).toEqual(["youtube"]);
    await service.close();
    // Closed, the profile on disk still tells, without starting a browser.
    expect(await service.signedIn()).toEqual(["youtube"]);
  });
});
