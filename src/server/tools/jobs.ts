import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dayOf } from "../../shared/coach.ts";
import type { Application } from "../../shared/contracts.ts";
import { ApplicationStatus } from "../../shared/contracts.ts";
import type { Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

/** Job boards, recruiting sites and the applicant tracking systems that companies' application forms run on. */
export const jobSites = [
  // Job boards
  "linkedin.com",
  "naukri.com",
  "indeed.com",
  "indeed.co.in",
  "glassdoor.com",
  "glassdoor.co.in",
  "wellfound.com",
  "foundit.in",
  "monster.com",
  "instahyre.com",
  "cutshort.io",
  "hirist.tech",
  "iimjobs.com",
  "internshala.com",
  "shine.com",
  "timesjobs.com",
  "apna.co",
  "dice.com",
  "ziprecruiter.com",
  "simplyhired.com",
  "builtin.com",
  "workatastartup.com",
  "remoteok.com",
  "weworkremotely.com",
  "remotive.com",
  "welcometothejungle.com",
  // Applicant tracking systems
  "greenhouse.io",
  "lever.co",
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "smartrecruiters.com",
  "ashbyhq.com",
  "icims.com",
  "taleo.net",
  "successfactors.com",
  "successfactors.eu",
  "jobvite.com",
  "bamboohr.com",
  "recruitee.com",
  "workable.com",
  "breezy.hr",
  "applytojob.com",
  "teamtailor.com",
  "personio.com",
  "personio.de",
  "zohorecruit.com",
  "zohorecruit.in",
  "freshteam.com",
  "darwinbox.in",
  "keka.com",
  "eightfold.ai",
  "avature.net",
  "oraclecloud.com",
];

/** A company's own careers pages: careers.acme.com, jobs.acme.com, acme.com/careers or acme.com/en/jobs/123. */
const careersHost = /^(careers?|jobs?|apply|talent|recruiting|hiring)\./i;
const careersPath =
  /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/)?(careers?|jobs?|join-us|joinus|work-with-us|openings|vacancies|positions|opportunities|apply)(\/|$)/i;

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Finding a company's careers page starts with a web search. */
const searchPage = (host: string, path: string) =>
  (/^google\.[a-z.]+$/.test(host) && path === "/search") ||
  host === "duckduckgo.com" ||
  host === "html.duckduckgo.com" ||
  (host === "bing.com" && path === "/search");

/**
 * Whether a bot's tab in a job search space may open an address: job sites, careers pages, web
 * search and the sites the person added. Everything else (mail, banks, other accounts) stays shut.
 */
export function jobSiteAllowed(raw: string, extra: string[] = []) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // A new tab starts blank, and pages build parts of themselves from data and blob addresses.
  if (url.protocol === "about:" || url.protocol === "data:" || url.protocol === "blob:") return true;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return (
    [...jobSites, ...extra].some((domain) => under(host, domain)) ||
    careersHost.test(host) ||
    careersPath.test(url.pathname) ||
    searchPage(host, url.pathname)
  );
}

/** The same job, however its link was copied: no query, no fragment, no trailing slash. */
const jobKey = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
};

const done = new Set<string>(["applied", "interview", "offer", "rejected"]);

/** Applications sent today, on this computer's calendar. */
export const appliedToday = (applications: Application[], today = dayOf()) =>
  applications.filter((application) => application.appliedAt && dayOf(new Date(application.appliedAt)) === today)
    .length;

export function applicationTools(store: {
  list: () => Application[];
  save: (applications: Application[]) => Promise<void>;
}): Tool[] {
  const find = (input: { url: string; company: string; role: string }) =>
    store
      .list()
      .find(
        (application) =>
          jobKey(application.url) === jobKey(input.url) ||
          (application.company.toLowerCase() === input.company.toLowerCase() &&
            application.role.toLowerCase() === input.role.toLowerCase()),
      );
  return [
    defineTool({
      name: "track_application",
      group: "knowledge",
      description:
        "Record a job in the application tracker, or move it on: found, ready, applied, interview, offer, rejected or skipped. A job already applied for is never recorded twice.",
      input: z.object({
        company: z.string().trim().min(1).max(120),
        role: z.string().trim().min(1).max(160),
        url: z.string().trim().min(1).max(2000).describe("The job's own page"),
        status: ApplicationStatus,
        note: z.string().trim().max(500).default("").describe("Why it fits, what is missing, or what happened"),
      }),
      async run(input) {
        const existing = find(input);
        if (existing && done.has(existing.status) && input.status === "applied") {
          return {
            text: `Already applied to ${existing.company} (${existing.role}) on ${existing.appliedAt?.slice(0, 10) ?? "an earlier day"}. Nothing changed; do not apply again.`,
          };
        }
        const at = new Date().toISOString();
        const next: Application = {
          id: existing?.id ?? randomUUID(),
          company: input.company,
          role: input.role,
          url: input.url,
          status: input.status,
          note: input.note || existing?.note || "",
          updatedAt: at,
          appliedAt: input.status === "applied" ? at : (existing?.appliedAt ?? null),
        };
        await store.save([next, ...store.list().filter((application) => application.id !== next.id)]);
        return { text: `${existing ? "Updated" : "Added"}: ${next.company}, ${next.role} (${next.status}).` };
      },
    }),
    defineTool({
      name: "list_applications",
      group: "knowledge",
      readOnly: true,
      description: "The application tracker: every job found or applied for, newest first, optionally of one status.",
      input: z.object({ status: ApplicationStatus.optional() }),
      async run({ status }) {
        const rows = store.list().filter((application) => !status || application.status === status);
        if (!rows.length) return { text: status ? `No jobs are ${status}.` : "The tracker is empty." };
        return {
          text: rows
            .slice(0, 200)
            .map(
              (application) =>
                `- [${application.status}] ${application.company}, ${application.role} · ${application.url} · ${application.updatedAt.slice(0, 10)}${application.note ? ` · ${application.note}` : ""}`,
            )
            .join("\n"),
        };
      },
    }),
  ];
}
