import { useState } from "react";
import type { PlatformId, Profile } from "../../shared/contracts.ts";
import { platformIds } from "../../shared/ids.ts";
import { platforms } from "../../shared/roster.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { platformIcon } from "../lib/meta.ts";
import { Button, cx, ErrorText, Field, Input, Section, Segmented } from "../ui.tsx";
import { SettingsPage } from "./settings-dialog.tsx";

export function BrandSettings() {
  const state = useAppState();
  const [profile, setProfile] = useState<Profile>(state.profile);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setSaved(false);
    setProfile((current) => ({ ...current, [key]: value }));
  };
  const toggle = (id: PlatformId) =>
    set(
      "platforms",
      profile.platforms.includes(id)
        ? profile.platforms.filter((platform) => platform !== id)
        : [...profile.platforms, id],
    );

  return (
    <SettingsPage title="Brand" description="Bots with automatic instructions follow these.">
      <Section>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={profile.brand} onChange={(event) => set("brand", event.target.value)} />
          </Field>
          <Field label="Niche">
            <Input
              value={profile.niche}
              placeholder="Home coffee for beginners"
              onChange={(event) => set("niche", event.target.value)}
            />
          </Field>
          <Field label="Audience">
            <Input
              value={profile.audience}
              placeholder="Students and young professionals"
              onChange={(event) => set("audience", event.target.value)}
            />
          </Field>
          <Field label="Voice">
            <Input value={profile.tone} onChange={(event) => set("tone", event.target.value)} />
          </Field>
          <Field label="Language">
            <Input value={profile.language} onChange={(event) => set("language", event.target.value)} />
          </Field>
          <Field label="Posts per week">
            <Input
              type="number"
              min={0}
              max={50}
              value={profile.postsPerWeek}
              onChange={(event) => set("postsPerWeek", Number(event.target.value))}
            />
          </Field>
        </div>
      </Section>
      <Section title="Platforms">
        <div className="flex flex-wrap gap-2">
          {platformIds.map((id) => {
            const Icon = platformIcon[id];
            const on = profile.platforms.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(id)}
                className={cx(
                  "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] transition",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
                )}
              >
                <Icon className="size-4" /> {platforms[id].name}
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Uploads">
        <Segmented
          label="Uploads"
          value={profile.publish}
          onChange={(publish) => set("publish", publish)}
          options={[
            { value: "draft", label: "Drafts only" },
            { value: "public", label: "Public when approved" },
          ]}
        />
      </Section>
      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={!profile.platforms.length || !profile.brand.trim()}
          onClick={() =>
            void api("PUT", "/profile", profile)
              .then(() => setSaved(true))
              .catch((failure: Error) => setError(failure.message))
          }
        >
          Save
        </Button>
        {saved ? <span className="text-xs text-success">Saved</span> : null}
      </div>
    </SettingsPage>
  );
}
