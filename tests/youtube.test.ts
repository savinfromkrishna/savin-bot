import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserService, otherChannel } from "../src/server/tools/browser.ts";
import type { Tool, ToolContext } from "../src/server/tools/tool.ts";
import { detectChannel, youtubeTools } from "../src/server/tools/youtube.ts";
import type { Channel, TakeoverAction } from "../src/shared/contracts.ts";

/** YouTube Studio's upload dialog, reduced to the parts the upload goes through, with the same selectors. */
const upload = `<!doctype html><title>Channel content - YouTube Studio</title>
<div id="entity-name">Brew Lab</div>
<input type="file" id="picker">
<div id="details" hidden>
  <div id="title-textarea"><div id="textbox" contenteditable="true">final</div></div>
  <div id="description-textarea"><div id="textbox" contenteditable="true"></div></div>
  <div role="radio" name="VIDEO_MADE_FOR_KIDS_MFK">Yes, it's made for kids</div>
  <div role="radio" name="VIDEO_MADE_FOR_KIDS_NOT_MFK" onclick="state.kids = false">No, it's not made for kids</div>
  <button id="next-button" onclick="state.steps++">Next</button>
  <div role="radio" name="PRIVATE" onclick="state.privacy = 'PRIVATE'">Private</div>
  <div role="radio" name="UNLISTED" onclick="state.privacy = 'UNLISTED'">Unlisted</div>
  <div role="radio" name="PUBLIC" onclick="state.privacy = 'PUBLIC'">Public</div>
  <span class="video-url-fadeable"><a href="https://youtu.be/abc123">https://youtu.be/abc123</a></span>
  <span class="progress-label">Uploading 10% ... 1 minute left</span>
  <button id="done-button" onclick="finish()">Save</button>
</div>
<script>
const state = { steps: 0, kids: null, privacy: null, file: null };
const picker = document.getElementById("picker");
picker.onchange = () => {
  state.file = picker.files[0].name;
  document.getElementById("details").hidden = false;
  setTimeout(() => { document.querySelector(".progress-label").textContent = "Upload complete"; }, 1200);
};
const finish = () => {
  state.title = document.querySelector("#title-textarea #textbox").innerText;
  state.description = document.querySelector("#description-textarea #textbox").innerText;
  state.uploading = document.querySelector(".progress-label").textContent.includes("Uploading");
  fetch("/done", { method: "POST", body: JSON.stringify(state) });
};
</script>`;

const installed = existsSync(chromium.executablePath());

describe.skipIf(!installed)("YouTube uploads", () => {
  const root = mkdtempSync(join(tmpdir(), "savin-social-youtube-"));
  writeFileSync(join(root, "final.mp4"), "not really a video");
  const finished: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/done") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        finished.push(JSON.parse(body));
        response.end("{}");
      });
      return;
    }
    // Studio opens on the signed-in channel, whatever channel was asked for.
    if (path === "/" || !path.startsWith("/channel/UCbrew/")) {
      response.writeHead(302, { location: "/channel/UCbrew/videos/upload?d=ud" }).end();
      return;
    }
    response.setHeader("content-type", "text/html").end(upload);
  });
  const browser = new BrowserService({ profileDir: join(root, ".profile"), headless: true, allowPrivateNetwork: true });
  let channel: Channel | null = null;
  let studio = "";
  let tool: Tool | undefined;
  let takeover: (reason: string, action?: TakeoverAction) => Promise<boolean> = async () => false;
  const context = (): ToolContext => ({
    runId: "run",
    botId: "publisher",
    signal: new AbortController().signal,
    workspaceDir: root,
    credentials: [],
    delegate: async () => "",
    handoff: async () => "",
    requestApproval: async () => true,
    requestTakeover: (reason, action) => takeover(reason, action),
    waitForControl: async () => {},
    activity: () => {},
  });
  const send = (input: Record<string, unknown>) => {
    const parsed = tool?.parse(input);
    if (!parsed?.ok) throw new Error(parsed?.error ?? "no tool");
    return tool?.run(parsed.value, context());
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    studio = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    [tool] = youtubeTools({ browser, channel: () => channel, studioUrl: studio });
  });

  afterAll(async () => {
    await browser.close();
    server.close();
  });

  it("finds the channel Studio opens on", async () => {
    expect(await detectChannel(browser, studio)).toEqual({ id: "UCbrew", title: "Brew Lab" });
  }, 60_000);

  it("asks for the channel once, then uploads only there and waits for the upload", async () => {
    const asked: (TakeoverAction | undefined)[] = [];
    takeover = async (_reason, action) => {
      asked.push(action);
      channel = { id: "UCbrew", title: "Brew Lab" };
      return true;
    };
    const result = await send({
      path: "final.mp4",
      title: "Latte art in 30 seconds",
      description: "Three pours.",
      privacy: "unlisted",
    });
    expect(asked).toEqual(["choose-channel"]);
    expect(result?.text).toBe("Uploaded to Brew Lab as unlisted: https://youtu.be/abc123.");
    expect(finished.at(-1)).toEqual({
      steps: 3,
      kids: false,
      privacy: "UNLISTED",
      file: "final.mp4",
      title: "Latte art in 30 seconds",
      description: "Three pours.",
      uploading: false,
    });
  }, 60_000);

  it("refuses any other channel, and stops when nobody chooses one", async () => {
    channel = { id: "UCother", title: "Someone else" };
    await expect(send({ path: "final.mp4", title: "t" })).rejects.toThrow(/did not open Someone else/);
    expect(otherChannel("https://studio.youtube.com/channel/UCother/videos", { id: "UCbrew", title: "Brew Lab" })).toBe(
      "UCother",
    );
    expect(
      otherChannel("https://studio.youtube.com/channel/UCbrew/videos", { id: "UCbrew", title: "Brew Lab" }),
    ).toBeNull();

    channel = null;
    takeover = async () => false;
    expect((await send({ path: "final.mp4", title: "t" }))?.text).toBe(
      "Nothing was uploaded: no channel is assigned for uploads.",
    );
  }, 60_000);
});
