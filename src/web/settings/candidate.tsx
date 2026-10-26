import { FileText, LogIn } from "lucide-react";
import { useRef, useState } from "react";
import type { Candidate } from "../../shared/contracts.ts";
import { api, uploadFile } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { useOverlay } from "../lib/overlay.ts";
import { Button, ErrorText, Field, Input, Section, Textarea } from "../ui.tsx";
import { SettingsPage } from "./settings-dialog.tsx";

/** A job search space's profile: what the team may say about the person, and nothing more. */
export function CandidateSettings() {
  const state = useAppState();
  const overlay = useOverlay();
  const [candidate, setCandidate] = useState<Candidate>(state.candidate);
  const [sites, setSites] = useState(state.candidate.sites.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Candidate>(key: K, value: Candidate[K]) => {
    setSaved(false);
    setCandidate((current) => ({ ...current, [key]: value }));
  };
  const text = (key: keyof Candidate, label: string, placeholder = "") => (
    <Field label={label}>
      <Input
        value={String(candidate[key])}
        placeholder={placeholder}
        onChange={(event) => set(key, event.target.value as never)}
      />
    </Field>
  );
  const save = () => {
    const next = {
      ...candidate,
      sites: sites
        .split(/[\s,]+/)
        .map((site) =>
          site
            .trim()
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, ""),
        )
        .filter(Boolean),
    };
    void api("PUT", "/candidate", next)
      .then(() => setSaved(true))
      .catch((failure: Error) => setError(failure.message));
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      set("resume", await uploadFile(`profile/${file.name}`, file));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const signIn = () => {
    const bot = state.bots.find((candidate) => candidate.tools.browser) ?? state.bots[0];
    void api("POST", "/candidate/sign-in").then(() =>
      overlay.set({ settings: null, computer: bot?.id ?? null, tab: "you", window: null }),
    );
  };

  return (
    <SettingsPage
      title="Candidate"
      description="The team applies with these facts and never invents others. Its browser opens job sites and careers pages only."
    >
      <Section>
        <div className="grid gap-4 sm:grid-cols-2">
          {text("name", "Name")}
          {text("email", "Email")}
          {text("phone", "Phone")}
          {text("location", "Location", "Pune, India")}
        </div>
        <Field label="Looking for">
          <Textarea
            rows={2}
            value={candidate.goals}
            placeholder="Frontend developer roles, React, Pune or remote, full time"
            onChange={(event) => set("goals", event.target.value)}
          />
        </Field>
        <Field label="Experience and skills">
          <Textarea
            rows={6}
            value={candidate.summary}
            placeholder="Jobs, years, projects, results, skills, education"
            onChange={(event) => set("summary", event.target.value)}
          />
        </Field>
        <Field label="Ready answers">
          <Textarea
            rows={4}
            value={candidate.answers}
            placeholder="Notice period, expected salary, work authorization, willing to relocate"
            onChange={(event) => set("answers", event.target.value)}
          />
        </Field>
        {text("links", "Links", "LinkedIn, GitHub, portfolio")}
      </Section>
      <Section title="Résumé">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={picker}
            type="file"
            accept=".pdf,.doc,.docx"
            hidden
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <Button busy={uploading} onClick={() => picker.current?.click()}>
            <FileText className="size-4" /> {candidate.resume ? "Replace résumé" : "Upload résumé"}
          </Button>
          {candidate.resume ? <span className="text-xs text-muted-foreground">{candidate.resume}</span> : null}
        </div>
      </Section>
      <Section title="Job sites">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Applications a day">
            <Input
              type="number"
              min={1}
              max={50}
              value={candidate.perDay}
              onChange={(event) => set("perDay", Number(event.target.value))}
            />
          </Field>
          <Field label="Also allow" hint="Job boards and careers pages are allowed already.">
            <Input
              value={sites}
              placeholder="jobs.example.com"
              onChange={(event) => {
                setSaved(false);
                setSites(event.target.value);
              }}
            />
          </Field>
        </div>
        <Button onClick={signIn}>
          <LogIn className="size-4" /> Sign in to job sites
        </Button>
      </Section>
      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        {saved ? <span className="text-xs text-success">Saved</span> : null}
      </div>
    </SettingsPage>
  );
}
