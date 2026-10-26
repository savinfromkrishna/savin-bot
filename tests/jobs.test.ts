import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botViews } from "../src/server/bots.ts";
import { Secrets } from "../src/server/secrets.ts";
import { missingTeam, Store } from "../src/server/store.ts";
import { BrowserService, browserTools } from "../src/server/tools/browser.ts";
import { applicationTools, appliedToday, jobSiteAllowed } from "../src/server/tools/jobs.ts";
import type { Tool, ToolContext } from "../src/server/tools/tool.ts";
import { dayOf } from "../src/shared/coach.ts";
import type { Application } from "../src/shared/contracts.ts";
import { call, fakeTool, reply, scripted, setup, until } from "./helpers.ts";

describe("job search space", () => {
  it("starts with the job search team, none of it on the terminal or desktop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "savin-social-jobs-"));
    const store = await Store.open(dir, Secrets.open(join(dir, "secret.key")), { kind: "jobs" });
    expect(store.state.kind).toBe("jobs");
    const bots = botViews(store.state);
    expect(bots.map((bot) => bot.id)).toEqual(["coordinator", "finder", "tailor", "applier"]);
    expect(bots.every((bot) => !bot.tools.shell && !bot.tools.screen && !bot.tools.video)).toBe(true);
    expect(bots.find((bot) => bot.id === "applier")?.instructions).toMatch(/never guess/);
    expect(bots.every((bot) => !bot.autoApply)).toBe(true);
    expect(store.state.routines.map((routine) => [routine.name, routine.active])).toEqual([
      ["Daily job search", false],
      ["Morning check-in", true],
      ["Weekly review", true],
    ]);
    // The Coordinator coaches from the person's own profiles, so it has the browser.
    expect(bots.find((bot) => bot.id === "coordinator")?.tools.browser).toBe(true);
    expect(store.state.habits).toEqual([]);
    expect(missingTeam(store.state.bots, "jobs")).toEqual({});
  });

  it("lets bots' tabs open job sites, careers pages and web search, and nothing else", () => {
    const allowed = [
      "https://www.linkedin.com/jobs/view/123",
      "https://www.naukri.com/job-listings-frontend-developer",
      "https://boards.greenhouse.io/acme/jobs/42",
      "https://jobs.lever.co/acme/1",
      "https://acme.wd5.myworkdayjobs.com/en-US/careers",
      "https://careers.acme.com/openings",
      "https://acme.com/careers/frontend",
      "https://acme.com/en-in/jobs/123",
      "https://www.google.co.in/search?q=acme+careers",
      "about:blank",
    ];
    const blocked = [
      "https://mail.google.com/mail/u/0/",
      "https://www.youtube.com/",
      "https://studio.youtube.com/channel/UC1",
      "https://netbanking.examplebank.com/",
      "https://acme.com/about",
      "https://www.google.com/maps",
      "file:///C:/Users/p/secret.txt",
      "chrome://settings",
    ];
    expect(allowed.filter((url) => !jobSiteAllowed(url))).toEqual([]);
    expect(blocked.filter((url) => jobSiteAllowed(url))).toEqual([]);
    expect(jobSiteAllowed("https://apply.acmecorp.io/form", [])).toBe(true);
    expect(jobSiteAllowed("https://hire.acmecorp.io/form")).toBe(false);
    expect(jobSiteAllowed("https://hire.acmecorp.io/form", ["acmecorp.io"])).toBe(true);
  });

  it("keeps a tracker that never records the same job as applied twice", async () => {
    let applications: Application[] = [];
    const tools = Object.fromEntries(
      applicationTools({
        list: () => applications,
        save: async (next) => {
          applications = next;
        },
      }).map((tool) => [tool.name, tool]),
    );
    const use = async (name: string, input: Record<string, unknown>) => {
      const tool = tools[name] as Tool;
      const parsed = tool.parse(input);
      if (!parsed.ok) throw new Error(parsed.error);
      return (await tool.run(parsed.value, {} as ToolContext)).text;
    };
    const job = { company: "Acme", role: "Frontend developer", url: "https://jobs.lever.co/acme/1?source=linkedin" };
    expect(await use("track_application", { ...job, status: "found", note: "React, Pune" })).toBe(
      "Added: Acme, Frontend developer (found).",
    );
    expect(await use("track_application", { ...job, status: "applied" })).toBe(
      "Updated: Acme, Frontend developer (applied).",
    );
    // The same job through another copy of its link.
    expect(await use("track_application", { ...job, url: "https://jobs.lever.co/acme/1/", status: "applied" })).toMatch(
      /^Already applied to Acme \(Frontend developer\) on \d{4}-\d\d-\d\d\. Nothing changed/,
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({ status: "applied", note: "React, Pune" });
    expect(await use("list_applications", { status: "applied" })).toMatch(/^- \[applied\] Acme, Frontend developer/);
  });

  it("never gives its bots the terminal, even when a bot's switch says so", async () => {
    const offered: string[][] = [];
    const provider = scripted((_bot, request, turn) => {
      offered.push(request.tools.map((tool) => tool.name));
      return turn === 0 ? { content: "", toolCalls: [call("terminal_run", {})] } : reply("done");
    });
    const shell = fakeTool("terminal_run", "shell");
    const { runtime, store } = await setup({
      provider,
      tools: [shell, fakeTool("browser_open", "browser", { readOnly: true })],
      change: (state) => {
        const bots = missingTeam({}, "jobs");
        const applier = bots.applier as (typeof bots)[string];
        return {
          ...state,
          kind: "jobs",
          bots: { ...bots, applier: { ...applier, tools: { ...applier.tools, shell: true } } },
        };
      },
    });
    await store.update((state) => ({
      ...state,
      candidate: { ...state.candidate, name: "Kanha", goals: "React roles" },
    }));
    let system = "";
    const run = runtime.start("applier", "Apply to the Acme job", { kind: "manual" });
    await runtime.wait(run.id);
    expect(offered[0]).toContain("browser_open");
    expect(offered[0]).not.toContain("terminal_run");
    expect(shell.calls).toEqual([]);
    system = String(run.steps.length ? "" : "");
    void system;
  });

  it("counts today's applications on this computer's calendar", () => {
    const sent = (at: Date): Application => ({
      id: at.toISOString(),
      company: "Acme",
      role: "Engineer",
      url: "https://jobs.example.com/1",
      status: "applied",
      note: "",
      updatedAt: at.toISOString(),
      appliedAt: at.toISOString(),
    });
    const today = dayOf(new Date(2026, 9, 25, 9, 0));
    const applications = [
      sent(new Date(2026, 9, 25, 0, 30)),
      sent(new Date(2026, 9, 25, 23, 30)),
      sent(new Date(2026, 9, 24, 23, 30)),
    ];
    expect(appliedToday(applications, today)).toBe(2);
  });

  it("tells its bots who they apply for and the rules, and nothing about social media", async () => {
    let system = "";
    const provider = scripted((_bot, request) => {
      system = String(request.messages[0]?.content);
      return reply("ok");
    });
    const { runtime, store } = await setup({
      provider,
      change: (state) => ({
        ...state,
        kind: "jobs",
        bots: missingTeam({}, "jobs"),
        candidate: { ...state.candidate, name: "Kanha", email: "kanha@example.com", goals: "React roles in Pune" },
      }),
    });
    await runtime.wait(runtime.start("finder", "Find jobs", { kind: "manual" }).id);
    expect(system).toMatch(/^You are Finder, the job search bot on Kanha's job search team\./);
    expect(system).toContain("- Email: kanha@example.com");
    expect(system).toContain("Every final submit waits for the person to allow it.");
    expect(system).toContain("Only job sites, recruiting sites, application systems and company careers pages open");
    expect(system).not.toMatch(/Brand|social media team|YouTube uploads/);

    // A bot allowed to apply on its own skips what it cannot answer instead of waiting.
    await store.updateBot("applier", (bot) => ({ ...bot, autoApply: true }));
    await runtime.wait(runtime.start("applier", "Apply", { kind: "manual" }).id);
    expect(system).toContain("Applications you submit go out without asking, up to 10 a day");
    expect(system).toContain("skip that job instead of waiting");
    expect(system).not.toContain("Every final submit waits");
  });
});

// A real headless Chromium against pages served from this process: no network needed.
const pages: Record<string, string> = {
  "/": `<!doctype html><title>Jobs</title>
<a href="/blocked">Somewhere else</a>
<button onclick="window.open('/form')">Apply on the company's site</button>`,
  "/blocked": "<!doctype html><title>Not a job site</title>",
  "/form": `<!doctype html><title>Apply</title>
<form onsubmit="event.preventDefault(); document.title = 'Sent'">
<input name="name" placeholder="Name"><input name="email" placeholder="Email"><input name="phone" placeholder="Phone">
<button type="button" onclick="document.title = 'Step 2'">Next</button>
<button>Submit application</button>
</form>`,
  "/profile": `<!doctype html><title>Profile</title>
<input placeholder="Headline"><button onclick="document.title = 'Saved'">Save</button>
<button onclick="document.title = 'Invited'">Connect</button><button>More</button>`,
};

const installed = existsSync(chromium.executablePath());

describe.skipIf(!installed)("job search browser", () => {
  const server = createServer((request, response) =>
    response.setHeader("content-type", "text/html").end(pages[request.url ?? "/"] ?? ""),
  );
  const root = mkdtempSync(join(tmpdir(), "savin-social-jobs-browser-"));
  const allowNavigation = (url: string) => !url.includes("/blocked");
  const browser = new BrowserService({
    profileDir: join(root, ".profile"),
    headless: true,
    allowPrivateNetwork: true,
    allowNavigation,
  });
  const tools = Object.fromEntries(
    browserTools(browser, { allowNavigation, confirmSubmit: true }).map((tool) => [tool.name, tool]),
  );
  const asked: string[] = [];
  const reasons: string[] = [];
  let allow = false;
  const context = (): ToolContext => ({
    runId: "run",
    botId: "applier",
    signal: new AbortController().signal,
    workspaceDir: root,
    credentials: [],
    delegate: async () => "",
    handoff: async () => "",
    requestApproval: async (summary, why) => {
      asked.push(summary);
      reasons.push(why);
      return allow;
    },
    requestTakeover: async () => true,
    waitForControl: async () => {},
    activity: () => {},
  });
  const use = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools[name] as Tool;
    const parsed = tool.parse(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return (await tool.run(parsed.value, context())).text;
  };
  const refOf = (text: string, label: string) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*"${label}`).exec(text)?.[1]);
  let url = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser.close();
    server.close();
  });

  it("keeps bots' tabs on job sites; the person's own tab goes anywhere", async () => {
    expect(await use("browser_open", { url: `${url}/blocked` })).toMatch(/is not a job site or careers page/);
    let text = await use("browser_open", { url: `${url}/` });
    text = await use("browser_click", { ref: refOf(text, "Somewhere else") });
    expect(text).toMatch(/^127\.0\.0\.1 is not a job site or careers page, so it did not open\./);
    expect(text).toContain(`URL: ${url}/\n`);
    expect(text).not.toContain("Not a job site");

    const mine = await browser.page("you");
    await mine.goto(`${url}/blocked`);
    expect(await mine.title()).toBe("Not a job site");
  }, 60_000);

  it("opens a window the bot opens in its own tab", async () => {
    const text = await use("browser_open", { url: `${url}/` });
    await use("browser_click", { ref: refOf(text, "Apply on the company") });
    const page = await browser.page("applier");
    await until(() => page.url() === `${url}/form`, 15_000);
    expect(await page.title()).toBe("Apply");
  }, 60_000);

  it("asks before sending an application, and never before the other buttons", async () => {
    let text = await use("browser_open", { url: `${url}/form` });
    text = await use("browser_click", { ref: refOf(text, "Next") });
    expect(asked).toEqual([]);
    expect(text).toContain("Page: Step 2");

    allow = false;
    expect(await use("browser_click", { ref: refOf(text, "Submit application") })).toMatch(/did not allow this/);
    expect(asked).toEqual(['Click "Submit application" on Step 2']);
    expect(await (await browser.page("applier")).title()).toBe("Step 2");

    // Enter in the form would send it too.
    text = await use("browser_snapshot");
    expect(await use("browser_type", { ref: refOf(text, "Phone"), text: "98765", submit: true })).toMatch(
      /did not allow this/,
    );
    expect(asked.at(-1)).toBe("Press Enter in the form on Step 2");

    allow = true;
    text = await use("browser_snapshot");
    text = await use("browser_click", { ref: refOf(text, "Submit application") });
    expect(text).toContain("Page: Sent");
  }, 60_000);

  it("lets a bot allowed to apply send applications on its own, up to the day's limit", async () => {
    let left = true;
    const own = Object.fromEntries(
      browserTools(browser, {
        allowNavigation,
        confirmSubmit: true,
        autoApply: (botId) => botId === "applier" && (left || "The day's limit is reached."),
      }).map((tool) => [tool.name, tool]),
    );
    const act = async (name: string, input: Record<string, unknown> = {}) => {
      const tool = own[name] as Tool;
      const parsed = tool.parse(input);
      if (!parsed.ok) throw new Error(parsed.error);
      return (await tool.run(parsed.value, context())).text;
    };
    allow = false;
    const before = asked.length;
    let text = await act("browser_open", { url: `${url}/form` });
    text = await act("browser_click", { ref: refOf(text, "Submit application") });
    expect(text).toContain("Page: Sent");
    expect(asked).toHaveLength(before);

    // Past the day's limit it asks again, and says why.
    left = false;
    text = await act("browser_open", { url: `${url}/form` });
    expect(await act("browser_click", { ref: refOf(text, "Submit application") })).toMatch(/did not allow this/);
    expect(reasons.at(-1)).toBe("The day's limit is reached.");

    // Anything that is not an application still asks.
    left = true;
    text = await act("browser_open", { url: `${url}/profile` });
    expect(await act("browser_click", { ref: refOf(text, "Save") })).toMatch(/did not allow this/);
    expect(await (await browser.page("applier")).title()).toBe("Profile");
  }, 60_000);

  it("asks before saving a profile or reaching out to someone", async () => {
    allow = false;
    let text = await use("browser_open", { url: `${url}/profile` });
    const before = asked.length;
    text = await use("browser_click", { ref: refOf(text, "More") });
    expect(asked).toHaveLength(before);

    expect(await use("browser_click", { ref: refOf(text, "Save") })).toMatch(/did not allow this/);
    expect(asked.at(-1)).toBe('Click "Save" on Profile');
    expect(reasons.at(-1)).toBe(
      "Changes to your profiles and messages to people go out only once you allow it. Allowing covers the rest of this task on 127.0.0.1.",
    );
    expect(await use("browser_click", { ref: refOf(text, "Connect") })).toMatch(/did not allow this/);
    expect(await (await browser.page("applier")).title()).toBe("Profile");

    allow = true;
    text = await use("browser_click", { ref: refOf(text, "Save") });
    expect(text).toContain("Page: Saved");
  }, 60_000);
});
