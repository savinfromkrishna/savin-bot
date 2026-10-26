import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserContext, Frame, Locator, Page, Route } from "playwright";
import { chromium } from "playwright";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { BotId, BrowserTab, Channel, PlatformId } from "../../shared/contracts.ts";
import { MAIN_BROWSER, parseTabKey, platformIds, tabKey } from "../../shared/ids.ts";
import type { OpenCredential, Tool, ToolContext } from "./tool.ts";
import { defineTool, workspacePath } from "./tool.ts";
import { privateUrlPattern, publicUrl } from "./web.ts";

export type BrowserOptions = {
  /** Which of the space's browsers this is; tabs of other browsers carry it in their key. */
  id?: string;
  profileDir: string;
  headless: boolean;
  channel?: string;
  /** Called whenever tabs open, close or navigate. */
  onTabs?: (tabs: BrowserTab[]) => void;
  /** Lets bots' tabs reach this machine and its network; only tests turn it on. */
  allowPrivateNetwork?: boolean;
  /** Where bots' tabs may go (a job search space: job sites only); the person's own tabs go anywhere. */
  allowNavigation?: (url: string) => boolean;
};

/** The frame a request comes from; a new window's first request and a service worker's have none. */
const frameOf = (route: Route) => {
  try {
    return route.request().frame();
  } catch {
    return null;
  }
};

/** Cookies a platform sets only for a signed-in account. Only their names are ever read. */
export const signInCookies: Record<PlatformId, { domain: string; names: string[] }> = {
  youtube: { domain: "youtube.com", names: ["LOGIN_INFO", "SID", "__Secure-1PSID", "__Secure-3PSID"] },
  instagram: { domain: "instagram.com", names: ["sessionid"] },
  tiktok: { domain: "tiktok.com", names: ["sessionid", "sessionid_ss", "sid_tt"] },
  x: { domain: "x.com", names: ["auth_token"] },
  linkedin: { domain: "linkedin.com", names: ["li_at"] },
  facebook: { domain: "facebook.com", names: ["c_user"] },
};

/** A Google account's own cookies, which Gemini (and a YouTube sign-in) rely on. */
export const googleCookies = { domain: "google.com", names: ["SID", "__Secure-1PSID", "__Secure-3PSID"] };

type CookieName = {
  domain: string;
  name: string /** Milliseconds, or null for a session cookie. */;
  expires: number | null;
};

/** Chromium stores expiry as microseconds since 1601. */
const CHROME_EPOCH_MS = 11_644_473_600_000;

type ViewerMessage =
  | { t: "click"; x: number; y: number; button?: "left" | "right" | "middle"; count?: number }
  | { t: "move"; x: number; y: number }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "key"; key: string }
  | { t: "text"; text: string }
  | { t: "nav"; url: string }
  | { t: "back" | "forward" | "reload" };

/** One persistent profile so platform sign-ins survive restarts; one tab per bot, plus "you". */
export class BrowserService {
  private context: Promise<BrowserContext> | null = null;
  private pages = new Map<string, Page>();
  private refused = new WeakMap<Page, string>();

  constructor(readonly options: BrowserOptions) {}

  private launch() {
    this.context ??= chromium
      .launchPersistentContext(this.options.profileDir, {
        headless: this.options.headless,
        channel: this.options.channel,
        viewport: { width: 1280, height: 800 },
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled"],
      })
      .then(
        (context) => {
          // Bots' tabs, and any window they open, never reach this machine or its network, where
          // this app's own API lives, nor (in a job search space) any page but a job site.
          if (!this.options.allowPrivateNetwork) {
            void context.route(privateUrlPattern, (route) => this.guard(route, "request"));
          }
          const allow = this.options.allowNavigation;
          if (allow) {
            void context.route("**/*", (route) => {
              const request = route.request();
              if (!request.isNavigationRequest() || allow(request.url())) return route.fallback();
              const frame = frameOf(route);
              // A new window's first page is let through: a bot's window reopens in its own tab, checked there.
              if (!frame) return route.fallback();
              return frame.parentFrame() === null ? this.guard(route, "page") : route.fallback();
            });
          }
          context.on("close", () => {
            this.context = null;
            this.pages.clear();
            this.announce();
          });
          return context;
        },
        (error) => {
          this.context = null;
          throw error;
        },
      );
    return this.context;
  }

  async page(key: string) {
    const existing = this.pages.get(key);
    if (existing && !existing.isClosed()) return existing;
    const context = await this.launch();
    const claimed = new Set(this.pages.values());
    const page = context.pages().find((p) => p.url() === "about:blank" && !claimed.has(p)) ?? (await context.newPage());
    this.pages.set(key, page);
    if (!key.startsWith("you")) page.on("popup", (popup) => void this.adopt(page, popup));
    page.on("framenavigated", (frame) => frame === page.mainFrame() && this.announce());
    page.on("load", () => this.announce());
    page.on("close", () => {
      if (this.pages.get(key) === page) this.pages.delete(key);
      this.announce();
    });
    this.announce();
    return page;
  }

  /** Lets a request through for the person's own tabs and the windows they open; stops it for the bots'. */
  /**
   * Lets a request through for the person's own tabs and the windows they open; stops it for the bots'.
   * A refused page is remembered, so the bot's tool can step back and say why.
   */
  private async guard(route: Route, refuse: "request" | "page") {
    const page = frameOf(route)?.page();
    if (page && (await this.personal(page))) return route.fallback();
    if (page && refuse === "page") this.refused.set(page, route.request().url());
    return route.abort("blockedbyclient");
  }

  /** The page a bot's tab was last refused, once. */
  takeRefused(page: Page) {
    const url = this.refused.get(page);
    this.refused.delete(page);
    return url;
  }

  private async personal(page: Page, depth = 0): Promise<boolean> {
    for (const [key, open] of this.pages) if (open === page) return key.startsWith("you");
    const opener = depth < 4 ? await page.opener().catch(() => null) : null;
    return opener ? this.personal(opener, depth + 1) : false;
  }

  /** A bot works in one tab, so a window it opens ("Apply on the company's site") opens there instead. */
  private async adopt(page: Page, popup: Page) {
    await popup.waitForURL((url) => url.protocol !== "about:", { timeout: 15_000 }).catch(() => {});
    const url = popup.url();
    await popup.close().catch(() => {});
    if (/^https?:/i.test(url)) await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  get id() {
    return this.options.id ?? MAIN_BROWSER;
  }

  async tabs(): Promise<BrowserTab[]> {
    const open = [...this.pages].filter(([, page]) => !page.isClosed());
    return Promise.all(
      open.map(async ([key, page]) => ({
        key: tabKey(this.id, key),
        browser: this.id,
        url: page.url(),
        title: await page.title().catch(() => ""),
      })),
    );
  }

  /** Opens the sign-in pages in the person's own tab; the bots reuse those sessions. */
  async open(urls: string[]) {
    const [first, ...rest] = urls;
    const page = await this.page("you");
    if (first) await page.goto(first, { waitUntil: "domcontentloaded" }).catch(() => {});
    for (const [index, url] of rest.entries()) {
      const tab = await this.page(`you-${index + 2}`);
      await tab.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  async closeTab(key: string) {
    await this.pages.get(key)?.close();
  }

  /** The platforms this profile is signed in to, so bots and people know which sessions they can use. */
  async signedIn(): Promise<PlatformId[]> {
    return (await this.signIns()).platforms;
  }

  /** The platforms, plus whether a Google account is signed in. */
  async signIns(): Promise<{ platforms: PlatformId[]; google: boolean }> {
    const cookies = await this.cookieNames();
    const now = Date.now();
    const has = (rule: { domain: string; names: string[] }) =>
      cookies.some(
        (cookie) =>
          (cookie.domain === rule.domain || cookie.domain.endsWith(`.${rule.domain}`)) &&
          rule.names.includes(cookie.name) &&
          (cookie.expires === null || cookie.expires > now),
      );
    return { platforms: platformIds.filter((platform) => has(signInCookies[platform])), google: has(googleCookies) };
  }

  /** From the open browser, or else from the profile on disk, without starting a browser. */
  private async cookieNames(): Promise<CookieName[]> {
    const context = this.context ? await this.context.catch(() => null) : null;
    if (context) {
      return (await context.cookies()).map((cookie) => ({
        domain: cookie.domain.replace(/^\./, ""),
        name: cookie.name,
        expires: cookie.expires > 0 ? cookie.expires * 1000 : null,
      }));
    }
    const file = join(this.options.profileDir, "Default", "Network", "Cookies");
    if (!existsSync(file)) return [];
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare("select host_key, name, cast(expires_utc as text) as expires from cookies").all() as {
          host_key: string;
          name: string;
          expires: string;
        }[];
        return rows.map((row) => ({
          domain: row.host_key.replace(/^\./, ""),
          name: row.name,
          expires: row.expires === "0" ? null : Number(BigInt(row.expires) / 1000n) - CHROME_EPOCH_MS,
        }));
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  /**
   * Streams a tab as JPEG frames. The viewer's clicks, scrolls and keys reach the page only
   * while `allowInput` says so (a person holding that bot's computer, or their own tab).
   */
  async stream(key: string, socket: WebSocket, allowInput: () => boolean = () => true) {
    const page = key.startsWith("you") ? await this.page(key) : this.pages.get(key);
    if (!page || page.isClosed()) return socket.close(4404, "No such tab");
    const session = await page.context().newCDPSession(page);
    const sendMeta = async () => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ t: "meta", url: page.url(), title: await page.title().catch(() => "") }));
    };
    const onNavigate = (frame: Frame) => frame === page.mainFrame() && void sendMeta();
    page.on("framenavigated", onNavigate);
    page.on("load", sendMeta);
    session.on("Page.screencastFrame", (frame) => {
      void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      // Drop frames rather than queue them when the viewer falls behind.
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < 1_500_000) {
        socket.send(Buffer.from(frame.data, "base64"));
      }
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800 });
    void sendMeta();

    const at = (x: number, y: number) => {
      const size = page.viewportSize() ?? { width: 1280, height: 800 };
      return [
        Math.round(Math.min(1, Math.max(0, x)) * size.width),
        Math.round(Math.min(1, Math.max(0, y)) * size.height),
      ] as const;
    };
    socket.on("message", async (raw) => {
      if (!allowInput()) return;
      try {
        const message = JSON.parse(String(raw)) as ViewerMessage;
        if (message.t === "click") {
          await page.mouse.click(...at(message.x, message.y), {
            button: message.button,
            clickCount: message.count ?? 1,
          });
        } else if (message.t === "move") await page.mouse.move(...at(message.x, message.y));
        else if (message.t === "wheel") await page.mouse.wheel(message.dx, message.dy);
        else if (message.t === "key") await page.keyboard.press(message.key);
        else if (message.t === "text") await page.keyboard.insertText(message.text);
        else if (message.t === "nav") {
          const target = key.startsWith("you") ? normalizeUrl(message.url) : (await publicUrl(message.url)).toString();
          await page.goto(target, { waitUntil: "domcontentloaded" });
        } else if (message.t === "back") await page.goBack();
        else if (message.t === "forward") await page.goForward();
        else if (message.t === "reload") await page.reload();
      } catch (error) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ t: "error", message: error instanceof Error ? error.message : String(error) }));
        }
      }
    });
    socket.on("close", () => {
      page.off("framenavigated", onNavigate);
      page.off("load", sendMeta);
      void session.send("Page.stopScreencast").catch(() => {});
      void session.detach().catch(() => {});
    });
  }

  async close() {
    const context = await this.context?.catch(() => null);
    await context?.close();
  }

  private announce() {
    if (!this.options.onTabs) return;
    void this.tabs().then(this.options.onTabs);
  }
}

/** Every browser of a space: the main one and any added for more accounts, each started on first use. */
export class Browsers {
  private services = new Map<string, BrowserService>();

  constructor(
    private readonly options: Omit<BrowserOptions, "id" | "profileDir" | "onTabs"> & {
      dir: (id: string) => string;
      /** Whether the space has this browser, so a stray tab key cannot create a profile. */
      known: (id: string) => boolean;
      onTabs?: (tabs: BrowserTab[]) => void;
    },
  ) {}

  get(id: string = MAIN_BROWSER) {
    let service = this.services.get(id);
    if (!service) {
      const { dir, known: _known, onTabs: _onTabs, ...rest } = this.options;
      service = new BrowserService({ ...rest, id, profileDir: dir(id), onTabs: () => this.announce() });
      this.services.set(id, service);
    }
    return service;
  }

  get main() {
    return this.get(MAIN_BROWSER);
  }

  async tabs(): Promise<BrowserTab[]> {
    return (await Promise.all([...this.services.values()].map((service) => service.tabs()))).flat();
  }

  /** Opens pages in the person's own tab of one browser: the main one unless another is named. */
  open(urls: string[], id: string = MAIN_BROWSER) {
    return this.get(id).open(urls);
  }

  closeTab(key: string) {
    const tab = parseTabKey(key);
    return this.services.get(tab.browser)?.closeTab(tab.key);
  }

  stream(key: string, socket: WebSocket, allowInput?: () => boolean) {
    const tab = parseTabKey(key);
    if (!this.options.known(tab.browser)) return socket.close(4404, "No such browser");
    return this.get(tab.browser).stream(tab.key, socket, allowInput);
  }

  /** Closes a browser for good and deletes its profile, sign-ins included. */
  async remove(id: string) {
    const service = this.services.get(id);
    this.services.delete(id);
    await service?.close();
    await rm(this.options.dir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    this.announce();
  }

  async close() {
    await Promise.all([...this.services.values()].map((service) => service.close()));
  }

  private announce() {
    if (this.options.onTabs) void this.tabs().then(this.options.onTabs);
  }
}

type Element = {
  ref: number;
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  value: string;
  inView: boolean;
};
type Collected = { title: string; url: string; text: string; elements: Element[] };

/**
 * Runs in the page: numbers visible interactive elements, including inside open shadow roots.
 * Kept as source text because transpilers rewrite named functions in ways the page cannot run.
 */
const collectScript = String.raw`(() => {
  const selector = "a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=''],[contenteditable=true]," +
    "[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=textbox],[role=combobox]";
  const elements = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      el.removeAttribute("data-rs-ref");
      if (el.shadowRoot) visit(el.shadowRoot);
      if (!el.matches(selector)) continue;
      const box = el.getBoundingClientRect();
      const fileInput = el.tagName === "INPUT" && el.type === "file";
      if (!fileInput && (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === "hidden")) continue;
      const ref = elements.length + 1;
      el.setAttribute("data-rs-ref", String(ref));
      const label = el.getAttribute("aria-label") || el.innerText || el.placeholder || el.title || el.getAttribute("alt") || "";
      elements.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        label: label.trim().replace(/\s+/g, " ").slice(0, 80),
        value: typeof el.value === "string" && el.tagName !== "BUTTON" && el.type !== "password" ? el.value.slice(0, 60) : "",
        inView: box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth,
      });
    }
  };
  visit(document);
  return { title: document.title, url: location.href, text: document.body ? document.body.innerText : "", elements };
})()`;

/** What the page shows; one that is navigating while it is read is read again once it has loaded. */
async function collect(page: Page): Promise<Collected> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await page.evaluate(collectScript)) as Collected;
    } catch (error) {
      if (attempt >= 2 || !/context was destroyed|navigat/i.test(String(error))) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    }
  }
}

export async function snapshot(page: Page) {
  let collected = await collect(page);
  // A page that builds itself in the browser can still be blank a moment after it loaded.
  for (
    let waited = 0;
    !collected.elements.length && collected.text.trim().length < 40 && waited < 5000;
    waited += 500
  ) {
    await page.waitForTimeout(500);
    collected = await collect(page);
  }
  const { title, url, text, elements } = collected;
  const ordered = [...elements.filter((e) => e.inView), ...elements.filter((e) => !e.inView)].slice(0, 180);
  const lines = ordered.map((e) => {
    const kind = e.role ?? (e.type ? `${e.tag}[${e.type}]` : e.tag);
    return `[${e.ref}] ${kind} "${e.label}"${e.value ? ` = "${e.value}"` : ""}${e.inView ? "" : " (scroll)"}`;
  });
  const body = text.replace(/\n{3,}/g, "\n\n").trim();
  return [
    `Page: ${title}`,
    `URL: ${url}`,
    "",
    "Elements:",
    ...(lines.length ? lines : ["(none)"]),
    elements.length > ordered.length ? `… ${elements.length - ordered.length} more` : "",
    "",
    "Text:",
    body.length > 5000 ? `${body.slice(0, 5000)}\n…` : body,
  ].join("\n");
}

const normalizeUrl = (url: string) => {
  const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  const { protocol } = new URL(full);
  if (protocol !== "http:" && protocol !== "https:") throw new Error("Only http and https pages can be opened");
  return full;
};

/** A YouTube Studio page of a channel other than the one uploads go to, if that is what `url` is. */
export function otherChannel(url: string, channel: Channel | null) {
  const id = /^https:\/\/studio\.youtube\.com\/channel\/(UC[\w-]+)/i.exec(url)?.[1];
  return channel && id && id !== channel.id ? id : null;
}

/** What a button that sends an application says. "Easy Apply" only opens the form, so it does not count. */
const SUBMIT =
  /\bsubmit\b|send (my |your |the )?application|^(apply|apply now|quick apply|1-click apply|one-click apply|finish|confirm and submit|complete application)$/i;
/** What a button that changes the person's profile or reaches other people says. */
const REACH =
  /^(save|save changes|update|update profile|post|publish|repost|send|send now|send invitation|send without a note|connect)$/i;

const labelOf = (target: Locator) =>
  target
    .evaluate((element) =>
      (
        element.getAttribute("aria-label") ||
        (element as HTMLElement).innerText ||
        (element as HTMLInputElement).value ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80),
    )
    .catch(() => "");

/** How many fields the focused element's form has: pressing Enter in a long form sends it. */
const formFields = (page: Page) =>
  page
    .evaluate(
      `(() => { const form = document.activeElement && document.activeElement.closest("form"); return form ? form.querySelectorAll("input:not([type=hidden]), textarea, select").length : 0; })()`,
    )
    .then(Number)
    .catch(() => 0);

const declined = {
  text: "The person did not allow this. Leave the form as it is and report what is waiting.",
};

export function browserTools(
  browser: BrowserService,
  options: {
    channel?: () => Channel | null;
    /** Where the bots may go; a refused page is explained to the bot. */
    allowNavigation?: (url: string) => boolean;
    /** Sending an application (its Submit or Apply) waits for the person. */
    confirmSubmit?: boolean;
    /**
     * Whether a bot sends applications without asking: true, false, or why this one waits for the person
     * after all (the day's limit is reached).
     */
    autoApply?: (botId: BotId) => boolean | string;
  } = {},
): Tool[] {
  // A person holding this bot's computer has the tab to themselves until they release it.
  const pageOf = async (context: ToolContext) => {
    await context.waitForControl();
    return browser.page(context.botId);
  };
  const element = (page: Page, ref: number) => page.locator(`[data-rs-ref="${ref}"]`).first();
  const settle = async (page: Page) => {
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(700);
    const refused = browser.takeRefused(page);
    if (refused) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
      return {
        text: `${new URL(refused).hostname} is not a job site or careers page, so it did not open.\n\n${await snapshot(page)}`,
      };
    }
    return { text: await snapshot(page) };
  };
  const ref = z.number().int().min(1).describe("Element number from the latest page snapshot");
  /** True when the action may go ahead: always, unless it sends an application and the person declines. */
  const allowSend = async (
    page: Page,
    context: ToolContext,
    action: string,
    why = "Applications are sent only once you allow it. Open the bot's computer to check the form first.",
    scope?: string,
  ) => {
    const title = (await page.title().catch(() => "")) || page.url();
    return context.requestApproval(`${action} on ${title}`, why, scope);
  };
  /** An application goes on its own from a bot allowed to apply, while the day's limit lasts; otherwise it asks. */
  const allowApplication = async (page: Page, context: ToolContext, action: string) => {
    const own = options.autoApply?.(context.botId) ?? false;
    return own === true || allowSend(page, context, action, typeof own === "string" ? own : undefined);
  };

  return [
    defineTool({
      name: "browser_open",
      group: "browser",
      readOnly: true,
      description: "Open a web page in your browser tab. Returns the page text and numbered interactive elements.",
      input: z.object({ url: z.string().min(1) }),
      async run({ url }, context) {
        const page = await pageOf(context);
        const target = browser.options.allowPrivateNetwork ? normalizeUrl(url) : (await publicUrl(url)).toString();
        if (options.allowNavigation && !options.allowNavigation(target)) {
          return {
            text: `${new URL(target).hostname} is not a job site or careers page, so this team's browser does not open it. A person can add it in Settings → Candidate.`,
          };
        }
        const channel = options.channel?.() ?? null;
        if (channel && otherChannel(target, channel)) {
          return {
            text: `Uploads go only to the channel ${channel.title}. Open https://studio.youtube.com/channel/${channel.id} instead.`,
          };
        }
        context.activity("open", target);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
        return settle(page);
      },
    }),
    defineTool({
      name: "browser_snapshot",
      group: "browser",
      readOnly: true,
      description: "Read the current page again, for example after it finished loading.",
      input: z.object({}),
      async run(_input, context) {
        return { text: await snapshot(await pageOf(context)) };
      },
    }),
    defineTool({
      name: "browser_click",
      group: "browser",
      description: "Click an element by its number.",
      input: z.object({ ref }),
      async run({ ref }, context) {
        const page = await pageOf(context);
        const target = element(page, ref);
        if (options.confirmSubmit) {
          const label = await labelOf(target);
          if (SUBMIT.test(label) && !(await allowApplication(page, context, `Click "${label}"`))) return declined;
          // Saving a profile change or reaching out asks once per site; allowing it covers the rest of the task.
          const reaches = REACH.test(label);
          const site = new URL(page.url()).hostname.replace(/^www\./, "");
          const why = `Changes to your profiles and messages to people go out only once you allow it. Allowing covers the rest of this task on ${site}.`;
          if (reaches && !(await allowSend(page, context, `Click "${label}"`, why, `reach:${site}`))) return declined;
        }
        await target.click({ timeout: 10_000 });
        return settle(page);
      },
    }),
    defineTool({
      name: "browser_type",
      group: "browser",
      description: "Replace the text in a field, optionally pressing Enter afterwards.",
      input: z.object({ ref, text: z.string().max(20_000), submit: z.boolean().optional() }),
      async run({ ref, text, submit }, context) {
        const page = await pageOf(context);
        const target = element(page, ref);
        await target.fill(text, { timeout: 10_000 }).catch(async () => {
          await target.click({ timeout: 10_000 });
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type(text);
        });
        if (submit) {
          const sends = options.confirmSubmit && (await formFields(page)) >= 3;
          if (sends && !(await allowApplication(page, context, "Press Enter in the form"))) return declined;
          await target.press("Enter");
        }
        return settle(page);
      },
    }),
    defineTool({
      name: "browser_press",
      group: "browser",
      description: "Press a key or shortcut on the page, such as Enter, Escape or Control+A.",
      input: z.object({ key: z.string().min(1).max(40) }),
      async run({ key }, context) {
        const page = await pageOf(context);
        const sends = options.confirmSubmit && /enter/i.test(key) && (await formFields(page)) >= 3;
        if (sends && !(await allowApplication(page, context, "Press Enter in the form"))) return declined;
        await page.keyboard.press(key);
        return settle(page);
      },
    }),
    defineTool({
      name: "browser_scroll",
      group: "browser",
      readOnly: true,
      description: "Scroll the page up or down by about one screen.",
      input: z.object({ direction: z.enum(["up", "down"]) }),
      async run({ direction }, context) {
        const page = await pageOf(context);
        await page.mouse.wheel(0, direction === "down" ? 700 : -700);
        return settle(page);
      },
    }),
    defineTool({
      name: "browser_upload",
      group: "browser",
      description: "Attach workspace files to a file input or to a button that opens a file picker.",
      input: z.object({ ref, files: z.array(z.string().min(1)).min(1).describe("Paths relative to the workspace") }),
      async run({ ref, files }, context) {
        const page = await pageOf(context);
        const channel = options.channel?.() ?? null;
        if (channel && otherChannel(page.url(), channel)) {
          return { text: `This is another channel's YouTube Studio. Uploads go only to ${channel.title}.` };
        }
        const paths = files.map((file) => workspacePath(context.workspaceDir, file));
        const target = element(page, ref);
        const isFileInput = (await target.getAttribute("type")) === "file";
        if (isFileInput) await target.setInputFiles(paths);
        else {
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10_000 }), target.click()]);
          await chooser.setFiles(paths);
        }
        return settle(page);
      },
    }),
    defineTool({
      name: "browser_login",
      group: "browser",
      description:
        "Fill a sign-in form with your saved website login for this site. You never see the password; pass the element numbers of the username and password fields.",
      input: z.object({ usernameRef: ref, passwordRef: ref, submit: z.boolean().optional() }),
      async run({ usernameRef, passwordRef, submit }, context) {
        const page = await pageOf(context);
        const host = new URL(page.url()).hostname;
        const login = context.credentials.find(
          (credential): credential is Extract<OpenCredential, { type: "login" }> =>
            credential.type === "login" && (host === credential.domain || host.endsWith(`.${credential.domain}`)),
        );
        if (!login) return { text: `No saved website login for ${host}. Ask a person to take over instead.` };
        await element(page, usernameRef).fill(login.username, { timeout: 10_000 });
        await element(page, passwordRef).fill(login.password, { timeout: 10_000 });
        if (submit) await element(page, passwordRef).press("Enter");
        return settle(page);
      },
    }),
    defineTool({
      name: "request_takeover",
      group: "browser",
      readOnly: true,
      description:
        "Ask a person to take over your browser, for example to sign in, pass a captcha or confirm a payment. Waits until they are done.",
      input: z.object({ reason: z.string().min(1).max(300) }),
      async run({ reason }, context) {
        const done = await context.requestTakeover(reason);
        if (!done) return { text: "The person skipped this. Continue without it or report what is blocked." };
        const page = await browser.page(context.botId);
        return { text: `The person is done.\n${await snapshot(page)}` };
      },
    }),
    defineTool({
      name: "browser_screenshot",
      group: "browser",
      readOnly: true,
      description: "See the visible part of the page as an image, for layouts, thumbnails and video previews.",
      input: z.object({}),
      async run(_input, context) {
        const image = await (await pageOf(context)).screenshot({ type: "jpeg", quality: 70 });
        return { text: "Screenshot of the page.", image: `data:image/jpeg;base64,${image.toString("base64")}` };
      },
    }),
  ];
}
