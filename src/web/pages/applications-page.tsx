import { ExternalLink, Trash2 } from "lucide-react";
import type { ApplicationStatus } from "../../shared/contracts.ts";
import { applicationStatuses } from "../../shared/ids.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { ago } from "../lib/meta.ts";
import { PageHeader } from "../shell/app-shell.tsx";
import { Button, cx, Select } from "../ui.tsx";

const statusLabel: Record<ApplicationStatus, string> = {
  found: "Found",
  ready: "Ready",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  skipped: "Skipped",
};

/** A job search space's tracker: every job the team found or applied for, newest first. */
export function ApplicationsPage() {
  const { applications } = useAppState();
  const today = new Date().toISOString().slice(0, 10);
  const appliedToday = applications.filter((application) => application.appliedAt?.slice(0, 10) === today).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <span className="text-[15px] font-semibold">Applications</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-3 px-4 py-6">
          <p className="px-1 text-xs text-muted-foreground">
            {applications.length} {applications.length === 1 ? "job" : "jobs"} · {appliedToday} applied today
          </p>
          {applications.length ? (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
              {applications.map((application) => (
                <li key={application.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <a
                      href={application.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex max-w-full items-center gap-1.5 text-[14px] font-medium hover:underline"
                    >
                      <span className="truncate">
                        {application.role} · {application.company}
                      </span>
                      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                    </a>
                    {application.note ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{application.note}</p>
                    ) : null}
                  </div>
                  <span className="text-xs text-muted-foreground">{ago(application.updatedAt)}</span>
                  <Select
                    aria-label={`Status of ${application.role} at ${application.company}`}
                    className={cx("h-8 w-32 text-xs", application.status === "applied" && "font-medium")}
                    value={application.status}
                    onChange={(event) =>
                      void api("PATCH", `/applications/${application.id}`, { status: event.target.value })
                    }
                  >
                    {applicationStatuses.map((status) => (
                      <option key={status} value={status}>
                        {statusLabel[status]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${application.role} at ${application.company}`}
                    onClick={() => void api("DELETE", `/applications/${application.id}`)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-[13px] text-muted-foreground">
              Jobs the team finds and applies for show up here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
