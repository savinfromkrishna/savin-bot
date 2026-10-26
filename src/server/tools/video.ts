import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { BrowserRecord } from "../store.ts";
import { videosToday } from "../store.ts";
import type { Browsers } from "./browser.ts";
import { snapshot } from "./browser.ts";
import type { Tool } from "./tool.ts";
import { defineTool, workspacePath } from "./tool.ts";
import { publicUrl } from "./web.ts";

export const GEMINI_URL = "https://gemini.google.com/app";
/** Google's sign-in page, coming back to Gemini once the account is in. */
export const GEMINI_SIGN_IN = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(GEMINI_URL)}`;

export type VideoOptions = {
  browsers: Pick<Browsers, "get">;
  /** The space's browsers, in the order they take turns. */
  list: () => BrowserRecord[];
  /** Whether a browser has a Google account signed in; the others are passed over. */
  signedIn: (id: string) => Promise<boolean>;
  /** Counts a video made today, or keeps why Gemini stopped making them. */
  record: (id: string, change: { made: true } | { stopped: string }) => Promise<void>;
  /** Gemini's address; tests point it at a local page. */
  geminiUrl?: string;
  /** How long one scene may take. */
  timeoutMs?: number;
  /** How often Gemini's page is checked while a scene is made. */
  pollMs?: number;
  /** Lets a video's address be on this machine or its network; only tests turn it on. */
  allowPrivateNetwork?: boolean;
};

/** No scene of a few seconds comes near this; anything bigger is not what Gemini made. */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
/** Containers video_join reads; playlists and other formats could make ffmpeg fetch addresses or read other files. */
const containers = new Set(["mov", "mp4", "matroska", "webm", "avi"]);

type Outcome =
  | { kind: "video"; data: Buffer }
  | { kind: "limit"; message: string }
  | { kind: "signed-out" }
  | { kind: "failed"; message: string };

/** Gemini's prompt box, most specific first: the page has other text fields, such as chat search. */
const EDITORS = [
  'rich-textarea [contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'textarea[aria-label*="prompt" i]',
];

/** Gemini telling this account it has used its videos for now. */
const LIMIT =
  /(reached|hit|exceeded|used up)\b[^.!?\n]{0,60}\blimit|\blimit\b[^.!?\n]{0,60}\b(reached|for today|tomorrow|resets?)|(come back|try again) tomorrow|no (more )?video generations? left|out of video generations/i;
/** An account whose plan does not include videos. */
const UPGRADE =
  /upgrade (to|your (plan|subscription|account))|need(s)? to upgrade|upgrade required|(available|included) (with|in|for) (google ai|gemini) (pro|ultra|advanced)|subscribe to (google ai|gemini)/i;
/** A reply that says the video is still coming. */
const BUSY =
  /generat|this (can|could|may|might) take|few minutes|creating|working on|getting (it|your video) ready|rendering|on its way|be ready/i;
const REFUSED =
  /\b(can't|cannot|can not|unable to|won't be able|not able to)\b|polic(y|ies)|guidelines|went wrong|try (a different|another|rephras)/i;

/*
 * Page scripts are kept as source text because transpilers rewrite named functions in ways the
 * page cannot run.
 */

/** The address of every video on the page, inside open shadow roots too. */
const videoSourcesScript = `(() => {
  const found = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName !== "VIDEO") continue;
      const source = el.querySelector("source");
      const src = el.currentSrc || el.src || (source ? source.src : "");
      if (src) found.push(src);
    }
  };
  visit(document);
  return found;
})()`;

/** What is on the page before asking, so the answer can be told apart. */
const beforeScript = String.raw`(() => ({
  responses: document.querySelectorAll("model-response").length,
  lines: document.body ? document.body.innerText.split("\n").map((line) => line.trim()).filter(Boolean) : [],
}))()`;

type Before = { responses: number; lines: string[] };

/** Gemini's newest answer: its last response, or else the page's new lines. */
const replyScript = (before: Before) => String.raw`(() => {
  const before = ${JSON.stringify(before)};
  const responses = document.querySelectorAll("model-response");
  if (responses.length > before.responses) return responses[responses.length - 1].innerText;
  const seen = new Set(before.lines);
  return document.body.innerText.split("\n").map((line) => line.trim()).filter((line) => line && !seen.has(line)).join("\n");
})()`;

/** A spinner, a progress bar or a Stop button: Gemini is still at it. */
const workingScript = `(() => {
  const busy = document.querySelectorAll('[role="progressbar"], mat-progress-spinner, mat-progress-bar, [aria-busy="true"], button[aria-label*="stop" i]');
  return [...busy].some((el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
})()`;

const blobScript = (url: string) => `(async () => {
  const blob = await (await fetch(${JSON.stringify(url)})).blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
})()`;

const clip = (text: string, max = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** The line of a reply that matched, as Gemini put it. */
const lineOf = (text: string, pattern: RegExp) =>
  clip(text.split("\n").find((line) => pattern.test(line)) ?? text, 200);

/** MP4 (an "ftyp" box) or WebM; anything else is an error page or a broken download. */
const isVideo = (data: Buffer) =>
  data.length > 1000 && (data.subarray(4, 8).toString("latin1") === "ftyp" || data.readUInt32BE(0) === 0x1a45dfa3);

/** Signs that Gemini took a prompt: one more question in the chat, or the chat's own address. */
const sentScript = `(() => ({ queries: document.querySelectorAll("user-query").length, url: location.href }))()`;
type Sent = { queries: number; url: string };

async function findEditor(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of EDITORS) {
      const editor = page.locator(selector).filter({ visible: true }).first();
      if (await editor.count()) return editor;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

const boxText = (editor: Locator) =>
  editor
    .evaluate((element) =>
      element instanceof HTMLTextAreaElement ? element.value : ((element as HTMLElement).innerText ?? ""),
    )
    .then((text) => text.trim())
    .catch(() => "");

/** Picks Video among Gemini's tools when the page offers it; asking for a video in words works without it. */
async function chooseVideoTool(page: Page) {
  const tools = page.getByRole("button", { name: /^(upload (&|and) )?tools$/i }).first();
  if (!(await tools.isVisible().catch(() => false))) return false;
  await tools.click({ timeout: 5000 }).catch(() => {});
  const item = page
    .locator('.cdk-overlay-container, [role="menu"], [role="listbox"], toolbox-drawer')
    .locator('[role="menuitem"], [role="menuitemcheckbox"], [role="option"], mat-list-item, button')
    .filter({ hasText: /\bvideos?\b/i })
    .first();
  const shown = await item.waitFor({ state: "visible", timeout: 3000 }).then(
    () => true,
    () => false,
  );
  if (shown) {
    return item.click({ timeout: 5000 }).then(
      () => true,
      () => false,
    );
  }
  await page.keyboard.press("Escape");
  return false;
}

/**
 * Types the prompt, sends it and checks that Gemini took it: a new question in the chat, a new chat
 * address or an emptied box. A second try fills the box another way; nothing is sent twice.
 */
async function ask(page: Page, editor: Locator, text: string) {
  const before = (await page.evaluate(sentScript)) as Sent;
  for (const attempt of [1, 2]) {
    await editor.click({ timeout: 10_000 });
    if (attempt === 1) await page.keyboard.insertText(text);
    else await editor.fill(text);
    await page.waitForTimeout(500);
    if (!(await boxText(editor))) continue;
    const send = page.locator('button[aria-label*="send" i]').filter({ visible: true }).first();
    if ((await send.count()) && (await send.isEnabled().catch(() => false))) await send.click({ timeout: 5000 });
    else await editor.press("Enter");
    for (let wait = 0; wait < 20; wait++) {
      await page.waitForTimeout(500);
      const now = (await page.evaluate(sentScript)) as Sent;
      if (now.queries > before.queries || now.url !== before.url || !(await boxText(editor))) return true;
    }
    // Still sitting in the box after ten seconds: it was not sent, so trying again cannot send it twice.
  }
  return false;
}

/**
 * When a scene fails, what the page looked like: a screenshot and its text and buttons, kept in the
 * workspace so a person (or a fix) can see what Gemini showed. Returns the screenshot's path.
 */
async function keepEvidence(page: Page, workspaceDir: string, browser: string) {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `${stamp}-${browser.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const dir = join(workspaceDir, "videos", ".gemini");
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`) });
    await writeFile(join(dir, `${name}.txt`), await snapshot(page));
    return `videos/.gemini/${name}.png`;
  } catch {
    return null;
  }
}

/** Gemini's own download button gives the file as made; the player's source is the fallback. */
async function fromDownloadButton(page: Page) {
  await page
    .locator("video")
    .last()
    .hover({ timeout: 3000 })
    .catch(() => {});
  const button = page.locator('button[aria-label*="download" i], [role="button"][aria-label*="download" i]').last();
  if (!(await button.count())) return null;
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    button.click({ timeout: 5000 }),
  ]);
  const path = await download.path();
  if ((await stat(path)).size > MAX_VIDEO_BYTES) throw new Error("the download was too big");
  return readFile(path);
}

async function download(page: Page, src: string, allowPrivateNetwork: boolean): Promise<Buffer> {
  const saved = await fromDownloadButton(page).catch(async () => {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  });
  if (saved && isVideo(saved)) return saved;
  const data =
    src.startsWith("blob:") || src.startsWith("data:")
      ? Buffer.from(String(await page.evaluate(blobScript(src))), "base64")
      : await fetchVideo(page, src, allowPrivateNetwork);
  if (data.length > MAX_VIDEO_BYTES) throw new Error("the download was too big");
  if (!isVideo(data)) throw new Error("the download was not a video");
  return data;
}

/**
 * The player's source, fetched with the browser's own sign-in. That request skips the tab's network
 * guard, so the address must be public (and https) first.
 */
async function fetchVideo(page: Page, src: string, allowPrivateNetwork: boolean) {
  if (!allowPrivateNetwork) {
    if (!src.startsWith("https://")) throw new Error("the video's address was not https");
    await publicUrl(src);
  }
  const response = await page.context().request.get(src, { timeout: 120_000, maxRedirects: 0 });
  if (!response.ok()) throw new Error(`the download failed (${response.status()})`);
  if (Number(response.headers()["content-length"] ?? 0) > MAX_VIDEO_BYTES) throw new Error("the download was too big");
  return response.body();
}

/** One scene in one browser: a new Gemini chat, the Video tool, the prompt, then the clip or the reason there is none. */
async function makeScene(
  page: Page,
  prompt: string,
  options: { url: string; signal: AbortSignal; timeoutMs: number; pollMs: number; allowPrivateNetwork: boolean },
): Promise<Outcome> {
  await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const editor = await findEditor(page, 30_000);
  const signIn = page.getByRole("link", { name: /^sign in$/i }).or(page.getByRole("button", { name: /^sign in$/i }));
  if (
    page.url().includes("accounts.google.com") ||
    (await signIn
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    return { kind: "signed-out" };
  }
  if (!editor) return { kind: "failed", message: "Gemini's prompt box did not show up" };
  const videoTool = await chooseVideoTool(page);
  // Let the page finish drawing, so what was already there is not taken for Gemini's answer.
  await page.waitForTimeout(1500);
  const before = (await page.evaluate(beforeScript)) as Before;
  const earlier = (await page.evaluate(videoSourcesScript)) as string[];
  const promptLines = new Set(prompt.split("\n").map((line) => line.trim()));
  if (!(await ask(page, editor, prompt))) {
    return {
      kind: "failed",
      message: `Gemini did not take the prompt (${videoTool ? "the Video tool was picked" : "no Video tool was found"})`,
    };
  }

  const started = Date.now();
  let reply = "";
  let confirmed = false;
  let quiet = 0;
  while (Date.now() - started < options.timeoutMs) {
    await page.waitForTimeout(options.pollMs);
    options.signal.throwIfAborted();
    const sources = (await page.evaluate(videoSourcesScript)) as string[];
    const fresh = sources.filter((src) => !earlier.includes(src)).at(-1);
    if (fresh) return { kind: "video", data: await download(page, fresh, options.allowPrivateNetwork) };
    reply = String(await page.evaluate(replyScript(before)))
      .split("\n")
      .filter((line) => !promptLines.has(line.trim()))
      .join("\n")
      .trim();
    if (LIMIT.test(reply)) return { kind: "limit", message: lineOf(reply, LIMIT) };
    if (UPGRADE.test(reply) || UPGRADE.test(await page.title().catch(() => ""))) {
      return { kind: "limit", message: "This Google account can't make videos; it needs Google AI Pro or Ultra." };
    }
    const working = BUSY.test(reply) || Boolean(await page.evaluate(workingScript));
    quiet = working || !reply ? 0 : quiet + 1;
    if (quiet < 3 || Date.now() - started < options.pollMs * 6) continue;
    // A finished answer without a video: a question gets one yes; a refusal, or two quiet minutes, ends the scene.
    if (!confirmed && reply.endsWith("?")) {
      confirmed = true;
      quiet = 0;
      await ask(page, editor, "Yes, make the video now.");
    } else if (REFUSED.test(reply) || quiet >= 48) return { kind: "failed", message: clip(reply) };
  }
  const minutes = Math.round(options.timeoutMs / 60_000);
  return {
    kind: "failed",
    message: reply
      ? `no video after ${minutes} minutes. Gemini said: ${clip(reply)}`
      : `no video after ${minutes} minutes`,
  };
}

// ---------- ffmpeg ----------

function ffmpeg(args: string[], signal: AbortSignal, timeoutMs = 20 * 60_000) {
  const binary = ffmpegPath;
  if (!binary) throw new Error("ffmpeg is not available on this machine.");
  return new Promise<{ code: number | null; log: string }>((resolve, reject) => {
    const child = spawn(binary, ["-hide_banner", "-nostdin", ...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr.on("data", (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-20_000);
    });
    const stop = () => child.kill();
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ code, log });
    });
  });
}

type Clip = { path: string; width: number; height: number; seconds: number; audio: boolean };

async function probe(path: string, signal: AbortSignal): Promise<Clip> {
  // Without an output ffmpeg only describes the input (and exits with an error, which is expected).
  const { log } = await ffmpeg(["-protocol_whitelist", "file", "-i", path], signal);
  const format = /Input #0, ([\w,]+), from/.exec(log)?.[1] ?? "";
  const video = /Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(log);
  if (!video || !format.split(",").some((name) => containers.has(name))) {
    throw new Error(`${basename(path)} is not a video file ffmpeg can join.`);
  }
  const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  return {
    path,
    width: Number(video[1]),
    height: Number(video[2]),
    seconds: time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0,
    audio: /Stream #.*Audio:/.test(log),
  };
}

const even = (value: number) => Math.round(value / 2) * 2;
const ratios = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1] } as const;

/** The result's frame: the first clip's, or the asked shape at its resolution (720p or 1080p). */
function frameOf(first: Clip, aspect: keyof typeof ratios | undefined) {
  if (!aspect) return { width: even(first.width), height: even(first.height) };
  const [w, h] = ratios[aspect];
  const short = Math.min(first.width, first.height) >= 1080 ? 1080 : 720;
  return w >= h ? { width: even((short * w) / h), height: short } : { width: short, height: even((short * h) / w) };
}

// ---------- Tools ----------

export function videoTools(options: VideoOptions): Tool[] {
  // One scene at a time, so two runs never share a browser or count the same video twice.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const url = options.geminiUrl ?? GEMINI_URL;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 2500;

  return [
    defineTool({
      name: "gemini_video",
      group: "video",
      description:
        "Make one video scene of about 8 seconds with Gemini in a signed-in browser and save it to the workspace as MP4. Takes a few minutes. When a browser reaches its daily limit, the next one takes over.",
      input: z.object({
        prompt: z
          .string()
          .trim()
          .min(10)
          .max(2000)
          .describe("The whole scene: subject, action, setting, camera, light, mood and any spoken line"),
        saveTo: z.string().trim().min(1).describe("Workspace path, such as videos/latte-art/scene-1.mp4"),
        aspect: z.enum(["16:9", "9:16"]).default("16:9"),
      }),
      run: ({ prompt, saveTo, aspect }, context) =>
        oneAtATime(async () => {
          context.signal.throwIfAborted();
          const target = workspacePath(context.workspaceDir, /\.mp4$/i.test(saveTo) ? saveTo : `${saveTo}.mp4`);
          const request = `Create a ${aspect === "9:16" ? "vertical 9:16" : "16:9"} video: ${prompt}`;
          // Why each browser was passed over during this call.
          const passed = new Map<string, string>();
          for (;;) {
            for (const browser of options.list()) {
              if (passed.has(browser.id)) continue;
              const today = videosToday(browser);
              if (today.stopped || today.made >= browser.videoLimit) {
                passed.set(
                  browser.id,
                  `${browser.name}: ${today.stopped ?? `made ${today.made} of ${browser.videoLimit} today`}`,
                );
                continue;
              }
              if (!(await options.signedIn(browser.id))) {
                passed.set(browser.id, `${browser.name}: not signed in to Google`);
                continue;
              }
              await context.waitForControl();
              context.activity("open", `Gemini in ${browser.name}`);
              const page = await options.browsers.get(browser.id).page(context.botId);
              const outcome = await makeScene(page, request, {
                url,
                signal: context.signal,
                timeoutMs,
                pollMs,
                allowPrivateNetwork: Boolean(options.allowPrivateNetwork),
              }).catch((error: unknown): Outcome => {
                if (context.signal.aborted) throw error;
                return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
              });
              if (outcome.kind === "video") {
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, outcome.data);
                await options.record(browser.id, { made: true });
                const path = relative(context.workspaceDir, target).replaceAll("\\", "/");
                return {
                  text: `Saved ${path} (${Math.round(outcome.data.length / 1024)} KB), made by Gemini in ${browser.name}: ${today.made + 1} of ${browser.videoLimit} videos there today.`,
                };
              }
              if (outcome.kind === "limit") {
                await options.record(browser.id, { stopped: outcome.message });
                passed.set(browser.id, `${browser.name}: ${outcome.message}`);
                continue;
              }
              if (outcome.kind === "signed-out") {
                passed.set(browser.id, `${browser.name}: not signed in to Gemini`);
                continue;
              }
              const shot = await keepEvidence(page, context.workspaceDir, browser.name);
              throw new Error(
                `Gemini in ${browser.name} did not make the scene: ${outcome.message}.${shot ? ` What the page showed: ${shot}.` : ""} A person can check that browser in Settings → Browsers.`,
              );
            }
            const reasons = [...passed.values()].join("; ");
            const added = await context.requestTakeover(
              `No browser can make Gemini videos right now (${reasons}). Add a browser signed in to Gemini, then press I'm done.`,
              "add-browser",
            );
            if (!added) return { text: `Nothing was made: no browser can make Gemini videos right now (${reasons}).` };
            passed.clear();
          }
        }),
    }),
    defineTool({
      name: "video_join",
      group: "video",
      description:
        "Join workspace video clips, in order, into one MP4. Clips of other sizes are fitted to the frame and clips without sound get silence.",
      input: z.object({
        clips: z.array(z.string().trim().min(1)).min(1).max(40).describe("Workspace paths, in playing order"),
        saveTo: z.string().trim().min(1).describe("Workspace path of the result, such as videos/latte-art/final.mp4"),
        aspect: z
          .enum(["16:9", "9:16", "1:1"])
          .optional()
          .describe("The result's shape; the first clip's when left out"),
        fit: z
          .enum(["crop", "pad"])
          .default("crop")
          .describe("crop fills the frame; pad keeps each whole picture with bars"),
      }),
      async run({ clips, saveTo, aspect, fit }, context) {
        const target = workspacePath(context.workspaceDir, /\.mp4$/i.test(saveTo) ? saveTo : `${saveTo}.mp4`);
        const inputs: Clip[] = [];
        for (const path of clips) {
          const full = workspacePath(context.workspaceDir, path);
          await stat(full).catch(() => {
            throw new Error(`${path} does not exist in the workspace.`);
          });
          inputs.push(await probe(full, context.signal));
        }
        const [first] = inputs;
        if (!first) throw new Error("No clips to join.");
        const { width, height } = frameOf(first, aspect);
        const frame =
          fit === "crop"
            ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
            : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
        const graph = [
          ...inputs.flatMap((input, index) => {
            const length = input.seconds > 0 ? `,apad,atrim=duration=${input.seconds}` : "";
            return [
              `[${index}:v]${frame},setsar=1,fps=30,format=yuv420p[v${index}]`,
              input.audio
                ? `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${length}[a${index}]`
                : `anullsrc=r=48000:cl=stereo,atrim=duration=${input.seconds || 1}[a${index}]`,
            ];
          }),
          `${inputs.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${inputs.length}:v=1:a=1[v][a]`,
        ].join(";");
        await mkdir(dirname(target), { recursive: true });
        context.activity("write", relative(context.workspaceDir, target));
        const { code, log } = await ffmpeg(
          [
            "-y",
            ...inputs.flatMap((input) => ["-protocol_whitelist", "file", "-i", input.path]),
            "-filter_complex",
            graph,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            target,
          ],
          context.signal,
        );
        if (code !== 0)
          throw new Error(`ffmpeg could not join the clips: ${clip(log.split("\n").slice(-6).join("\n"))}`);
        const seconds = Math.round(inputs.reduce((total, input) => total + input.seconds, 0));
        const path = relative(context.workspaceDir, target).replaceAll("\\", "/");
        return { text: `Joined ${inputs.length} clips into ${path}: about ${seconds} seconds, ${width}x${height}.` };
      },
    }),
  ];
}
