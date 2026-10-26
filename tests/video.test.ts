import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserRecord } from "../src/server/store.ts";
import { newBrowser } from "../src/server/store.ts";
import { Browsers } from "../src/server/tools/browser.ts";
import type { Tool, ToolContext } from "../src/server/tools/tool.ts";
import { videoTools } from "../src/server/tools/video.ts";
import type { TakeoverAction } from "../src/shared/contracts.ts";

/**
 * A stand-in for Gemini with the same shape as the real page: a Tools menu with Video, a prompt
 * box, a Send button, and an answer that turns into a video (with a download button), a limit
 * message or a refusal, as the test asks. A cookie tells the browsers apart.
 */
const gemini = `<!doctype html><title>Gemini</title>
<nav><a href="#">Latte art video ideas</a></nav>
<main id="chat"></main>
<button aria-label="Upload & tools" id="tools">+</button>
<div role="menu" id="menu" hidden>
  <button role="menuitemcheckbox" id="video">Video</button>
  <button role="menuitemcheckbox">Deep Research</button>
</div>
<rich-textarea><div contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div></rich-textarea>
<button aria-label="Send message" id="send">Send</button>
<script>
const editor = document.querySelector("[contenteditable]");
let videoTool = false;
document.getElementById("tools").onclick = () => { document.getElementById("menu").hidden = false; };
document.getElementById("video").onclick = () => { videoTool = true; document.getElementById("menu").hidden = true; };
const send = async () => {
  const text = editor.innerText.trim();
  editor.innerText = "";
  const query = document.createElement("user-query");
  query.textContent = text;
  const answer = document.createElement("model-response");
  answer.innerHTML = "<p>Generating your video… This could take a few minutes.</p>";
  document.getElementById("chat").append(query, answer);
  const result = await (await fetch("/ask", { method: "POST", body: JSON.stringify({ text, videoTool }) })).json();
  setTimeout(() => {
    if (result.kind === "limit") answer.innerHTML = "<p>You've reached your daily limit for video generation. Try again tomorrow.</p>";
    else if (result.kind === "refuse") answer.innerHTML = "<p>I can't create that video because it goes against my guidelines.</p>";
    else if (result.kind === "upgrade") { answer.innerHTML = "<p>I'm here to help, but you'll need to <a href='#'>upgrade your subscription</a> first.</p>"; document.title = "Subscription Upgrade Required - Google Gemini"; }
    else {
      const src = "/clip.mp4?n=" + result.n;
      answer.innerHTML = "<p>Here is your video.</p><video controls src='" + src + "'></video>" +
        (result.kind === "video" ? "<button aria-label='Download video' id='download'>Download</button>" : "");
      const button = document.getElementById("download");
      if (button) button.onclick = () => { const link = document.createElement("a"); link.href = src; link.download = "video.mp4"; document.body.append(link); link.click(); };
    }
  }, 300);
};
document.getElementById("send").onclick = send;
</script>`;

const installed = existsSync(chromium.executablePath()) && Boolean(ffmpegPath);

describe.skipIf(!installed)("Gemini video", () => {
  const root = mkdtempSync(join(tmpdir(), "savin-social-video-"));
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  const clip = join(root, "clip.mp4");
  const square = join(workspaceDir, "square.mp4");
  /** What Gemini answers next, in order; a video once the list is empty. */
  const answers: ("limit" | "refuse" | "upgrade" | "video" | "no-button")[] = [];
  const asks: { text: string; videoTool: boolean; who: string }[] = [];
  let made = 0;
  const fetched: string[] = [];
  let browserCount = 0;

  const server = createServer((request, response) => {
    if (request.url?.startsWith("/clip.mp4")) {
      response.setHeader("content-type", "video/mp4").end(readFileSync(clip));
      return;
    }
    if (request.url === "/secret") {
      fetched.push(request.url);
      response.end("secret");
      return;
    }
    if (request.url === "/ask") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const who = /who=(\w+)/.exec(request.headers.cookie ?? "")?.[1] ?? "?";
        asks.push({ ...JSON.parse(body), who });
        const kind = answers.shift() ?? "video";
        if (kind === "video" || kind === "no-button") made++;
        response.setHeader("content-type", "application/json").end(JSON.stringify({ kind, n: made }));
      });
      return;
    }
    if (!/who=/.test(request.headers.cookie ?? "")) response.setHeader("set-cookie", `who=b${++browserCount}; Path=/`);
    response.setHeader("content-type", "text/html").end(gemini);
  });
  const browsers = new Browsers({
    dir: (id) => join(root, "profiles", id),
    known: () => true,
    headless: true,
    allowPrivateNetwork: true,
  });
  let records: BrowserRecord[] = [];
  let tools: Record<string, Tool> = {};
  let takeover: (reason: string, action?: TakeoverAction) => Promise<boolean> = async () => false;

  const context = (): ToolContext => ({
    runId: "run",
    botId: "producer",
    signal: new AbortController().signal,
    workspaceDir,
    credentials: [],
    delegate: async () => "",
    handoff: async () => "",
    requestApproval: async () => true,
    requestTakeover: (reason, action) => takeover(reason, action),
    waitForControl: async () => {},
    activity: () => {},
  });
  const use = (name: string, input: Record<string, unknown>) => {
    const tool = tools[name];
    if (!tool) throw new Error(`no tool ${name}`);
    const parsed = tool.parse(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return tool.run(parsed.value, context());
  };
  const browser = (id: string, change: Partial<BrowserRecord> = {}) => ({ ...newBrowser(id, id), ...change });
  const probe = (path: string) => {
    try {
      execFileSync(ffmpegPath as string, ["-hide_banner", "-i", path], { stdio: "pipe" });
    } catch (error) {
      return String((error as { stderr: Buffer }).stderr);
    }
    return "";
  };

  beforeAll(async () => {
    const ffmpeg = (args: string[]) =>
      execFileSync(ffmpegPath as string, ["-hide_banner", "-y", ...args], { stdio: "pipe" });
    ffmpeg(
      ["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=1"].concat([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        clip,
      ]),
    );
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=200x200:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", square]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
    tools = Object.fromEntries(
      videoTools({
        browsers,
        list: () => records,
        signedIn: async (id) => id !== "signed-out",
        record: async (id, change) => {
          records = records.map((record) =>
            record.id !== id
              ? record
              : {
                  ...record,
                  videos:
                    "made" in change
                      ? { ...record.videos, made: record.videos.made + 1 }
                      : { ...record.videos, stopped: change.stopped },
                },
          );
        },
        geminiUrl: url,
        timeoutMs: 20_000,
        pollMs: 200,
        allowPrivateNetwork: true,
      }).map((tool) => [tool.name, tool]),
    );
  });

  afterAll(async () => {
    await browsers.close();
    server.close();
  });

  it("makes a scene with Gemini's Video tool and saves the clip", async () => {
    records = [browser("main")];
    const { text } = await use("gemini_video", {
      prompt: "A barista pours a rosetta in slow motion, warm morning light",
      saveTo: "videos/latte/scene-1.mp4",
      aspect: "9:16",
    });
    expect(text).toMatch(/^Saved videos\/latte\/scene-1\.mp4 .* in main: 1 of 3 videos there today\.$/);
    expect(readFileSync(join(workspaceDir, "videos/latte/scene-1.mp4")).equals(readFileSync(clip))).toBe(true);
    expect(asks.at(-1)).toMatchObject({
      text: "Create a vertical 9:16 video: A barista pours a rosetta in slow motion, warm morning light",
      videoTool: true,
    });
    expect(records[0]?.videos.made).toBe(1);
  }, 60_000);

  it("moves to the next browser at its daily count or when Gemini says the limit is reached", async () => {
    records = [
      browser("main", { videoLimit: 1, videos: { ...newBrowser("x", "x").videos, made: 1 } }),
      browser("signed-out"),
      browser("free"),
      browser("second"),
      browser("third"),
    ];
    answers.push("upgrade", "limit", "no-button");
    const before = asks.length;
    const { text } = await use("gemini_video", {
      prompt: "Steam rising from a fresh cup",
      saveTo: "videos/latte/scene-2",
    });
    expect(text).toMatch(/^Saved videos\/latte\/scene-2\.mp4 .* in third: 1 of 3/);
    const used = asks.slice(before).map((ask) => ask.who);
    expect(used).toHaveLength(3);
    expect(new Set(used).size).toBe(3);
    expect(records.find((record) => record.id === "free")?.videos.stopped).toBe(
      "This Google account can't make videos; it needs Google AI Pro or Ultra.",
    );
    expect(records.find((record) => record.id === "second")?.videos.stopped).toMatch(/reached your daily limit/);
    expect(records.find((record) => record.id === "main")?.videos.made).toBe(1);
    // The player's own source works when there is no download button.
    expect(readFileSync(join(workspaceDir, "videos/latte/scene-2.mp4")).equals(readFileSync(clip))).toBe(true);
  }, 60_000);

  it("asks for another browser when none is left, and carries on with it", async () => {
    records = [browser("main", { videos: { ...newBrowser("x", "x").videos, stopped: "Limit reached" } })];
    const asked: { reason: string; action?: TakeoverAction }[] = [];
    takeover = async (reason, action) => {
      asked.push({ reason, action });
      records = [...records, browser("added")];
      return true;
    };
    const { text } = await use("gemini_video", {
      prompt: "Latte art heart, top-down shot",
      saveTo: "videos/latte/scene-3.mp4",
    });
    expect(asked).toEqual([
      {
        reason:
          "No browser can make Gemini videos right now (main: Limit reached). Add a browser signed in to Gemini, then press I'm done.",
        action: "add-browser",
      },
    ]);
    expect(text).toMatch(/in added: 1 of 3/);

    records = [browser("main", { videoLimit: 0 })];
    takeover = async () => false;
    expect((await use("gemini_video", { prompt: "One more pour, close up", saveTo: "x.mp4" })).text).toBe(
      "Nothing was made: no browser can make Gemini videos right now (main: made 0 of 0 today).",
    );
  }, 60_000);

  it("reports a refusal without using up another browser", async () => {
    records = [browser("main"), browser("second")];
    answers.push("refuse");
    const before = asks.length;
    const failure = await use("gemini_video", { prompt: "Something Gemini will not make", saveTo: "no.mp4" }).catch(
      (error: Error) => error.message,
    );
    expect(failure).toMatch(/^Gemini in main did not make the scene: I can't create that video/);
    // What the page showed is kept for a person to look at.
    const shot = /What the page showed: (videos\/\.gemini\/[\w-]+-main\.png)\./.exec(String(failure))?.[1];
    expect(shot && existsSync(join(workspaceDir, shot))).toBe(true);
    expect(readFileSync(join(workspaceDir, String(shot).replace(/png$/, "txt")), "utf8")).toMatch(/Send message/);
    expect(asks.length - before).toBe(1);
    expect(records.map((record) => record.videos.made)).toEqual([0, 0]);
  }, 60_000);

  it("joins clips of other shapes, with and without sound, into one video", async () => {
    const { text } = await use("video_join", {
      clips: ["videos/latte/scene-1.mp4", "square.mp4"],
      saveTo: "videos/latte/final",
      aspect: "9:16",
    });
    expect(text).toBe("Joined 2 clips into videos/latte/final.mp4: about 2 seconds, 720x1280.");
    const info = probe(join(workspaceDir, "videos/latte/final.mp4"));
    expect(info).toMatch(/Video: h264.*720x1280/);
    expect(info).toMatch(/Audio: aac/);
    expect(info).toMatch(/Duration: 00:00:0[12]/);
    await expect(use("video_join", { clips: ["missing.mp4"], saveTo: "out.mp4" })).rejects.toThrow(
      "missing.mp4 does not exist in the workspace.",
    );

    // A playlist dressed up as a video could make ffmpeg fetch addresses or read other files.
    const port = (server.address() as AddressInfo).port;
    writeFileSync(
      join(workspaceDir, "trap.mp4"),
      `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${port}/secret\n#EXT-X-ENDLIST\n`,
    );
    await expect(use("video_join", { clips: ["trap.mp4"], saveTo: "out.mp4" })).rejects.toThrow(
      "trap.mp4 is not a video file ffmpeg can join.",
    );
    expect(fetched).toEqual([]);
  }, 60_000);
});
