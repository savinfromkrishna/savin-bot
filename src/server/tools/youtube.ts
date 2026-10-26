import { stat } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { Channel } from "../../shared/contracts.ts";
import type { BrowserService } from "./browser.ts";
import type { Tool } from "./tool.ts";
import { defineTool, workspacePath } from "./tool.ts";

export const STUDIO_URL = "https://studio.youtube.com";

export type YouTubeOptions = {
  /** The main browser, where YouTube is signed in. */
  browser: BrowserService;
  /** The channel uploads go to; nothing is uploaded anywhere else. */
  channel: () => Channel | null;
  /** YouTube Studio's address; tests point it at a local page. */
  studioUrl?: string;
};

/** The channel YouTube Studio opens on in this browser: the id from the address, the name from the page. */
export async function detectChannel(browser: BrowserService, studioUrl = STUDIO_URL): Promise<Channel | null> {
  const page = await browser.page("channel-check");
  try {
    await page.goto(studioUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForURL(/\/channel\/UC[\w-]+/, { timeout: 30_000 }).catch(() => {});
    const id = /\/channel\/(UC[\w-]+)/.exec(page.url())?.[1];
    if (!id) return null;
    const name = await page
      .locator("#entity-name")
      .first()
      .textContent({ timeout: 15_000 })
      .catch(() => null);
    return { id, title: name?.trim() || id };
  } finally {
    await page.close().catch(() => {});
  }
}

async function replaceText(page: Page, box: Locator, text: string) {
  await box.click({ timeout: 60_000 });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
}

export function youtubeTools(options: YouTubeOptions): Tool[] {
  const studio = options.studioUrl ?? STUDIO_URL;
  return [
    defineTool({
      name: "youtube_studio_upload",
      group: "browser",
      category: "publish",
      description:
        "Upload a workspace video through YouTube Studio in the signed-in browser, to the channel assigned for uploads and never any other. Waits until the upload finishes.",
      input: z.object({
        path: z.string().trim().min(1).describe("Workspace path of the video"),
        title: z.string().trim().min(1).max(100),
        description: z.string().max(5000).default(""),
        privacy: z.enum(["private", "unlisted", "public"]).default("private"),
      }),
      async run(input, context) {
        let channel = options.channel();
        while (!channel) {
          const chosen = await context.requestTakeover(
            "Choose the YouTube channel the team uploads to, then press I'm done.",
            "choose-channel",
          );
          if (!chosen) return { text: "Nothing was uploaded: no channel is assigned for uploads." };
          channel = options.channel();
        }
        const file = workspacePath(context.workspaceDir, input.path);
        await stat(file).catch(() => {
          throw new Error(`${input.path} does not exist in the workspace.`);
        });
        await context.waitForControl();
        const page = await options.browser.page(context.botId);
        context.activity("open", `YouTube Studio · ${channel.title}`);
        await page.goto(`${studio}/channel/${channel.id}/videos/upload?d=ud`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(1500);
        if (!page.url().includes(`/channel/${channel.id}`)) {
          throw new Error(
            `YouTube Studio did not open ${channel.title}. Sign the main browser in to the Google account that owns it.`,
          );
        }
        const step = async <T>(what: string, work: () => Promise<T>) => {
          try {
            return await work();
          } catch (error) {
            if (context.signal.aborted) throw error;
            const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
            throw new Error(
              `YouTube Studio stopped at ${what} (${reason}). The upload page is still open in the browser.`,
            );
          }
        };
        await step("choosing the file", () =>
          page.locator('input[type="file"]').first().setInputFiles(file, { timeout: 60_000 }),
        );
        await step("the title", () => replaceText(page, page.locator("#title-textarea #textbox").first(), input.title));
        if (input.description) {
          await step("the description", () =>
            replaceText(page, page.locator("#description-textarea #textbox").first(), input.description),
          );
        }
        await step("the audience", () =>
          page.locator('[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first().click({ timeout: 30_000 }),
        );
        for (let next = 0; next < 3; next++) {
          await step("Next", () => page.locator("#next-button").first().click({ timeout: 30_000 }));
          await page.waitForTimeout(800);
        }
        await step("the visibility", () =>
          page.locator(`[name="${input.privacy.toUpperCase()}"]`).first().click({ timeout: 30_000 }),
        );
        const link = await page
          .locator("span.video-url-fadeable a, a.ytcp-video-info")
          .first()
          .getAttribute("href", { timeout: 10_000 })
          .catch(() => null);
        // Leaving the page cancels an upload, so Done waits until the file is up.
        await step("finishing the upload", async () => {
          const started = Date.now();
          const progress = page.locator(".progress-label, ytcp-video-upload-progress").first();
          while (/uploading/i.test(await progress.innerText({ timeout: 1000 }).catch(() => ""))) {
            if (Date.now() - started > 60 * 60_000) throw new Error("the upload took over an hour");
            context.signal.throwIfAborted();
            await page.waitForTimeout(3000);
          }
          await page.locator("#done-button").first().click({ timeout: 60_000 });
        });
        await page.waitForTimeout(2000);
        await page
          .locator("#close-button")
          .first()
          .click({ timeout: 5000 })
          .catch(() => {});
        return { text: `Uploaded to ${channel.title} as ${input.privacy}${link ? `: ${link}` : ""}.` };
      },
    }),
  ];
}
