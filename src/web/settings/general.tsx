import { ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApprovalRule, Preferences, RuleCategory, VoiceStatus } from "../../shared/contracts.ts";
import type { DictationLanguage } from "../../shared/ids.ts";
import { dictationLanguages } from "../../shared/ids.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { toolLabel } from "../lib/meta.ts";
import { Button, ErrorText, Field, Input, Section, Segmented, Select, SwitchRow } from "../ui.tsx";
import { SettingsPage } from "./settings-dialog.tsx";

const presets: { category: RuleCategory; label: string }[] = [
  { category: "publish", label: "Ask before publishing posts" },
  { category: "message", label: "Ask before sending messages" },
  { category: "spend", label: "Ask before spending credits" },
];

const categoryNames: Record<RuleCategory, string> = {
  publish: "publishing posts",
  message: "sending messages",
  spend: "spending credits",
};

function sentence(rule: ApprovalRule, connectorNames: Record<string, string>) {
  const { target } = rule;
  const subject =
    target.kind === "tool"
      ? toolLabel(target.tool).toLowerCase()
      : target.kind === "connector"
        ? `${connectorNames[target.connectorId] ?? target.connectorId} actions`
        : categoryNames[target.category];
  return rule.action === "always_allow" ? `Allow ${subject} without asking` : `Ask before ${subject}`;
}

/** The speech model voice typing runs on: it downloads once, then works without the internet. */
function SpeechModel() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const downloading = status?.state === "downloading";
  useEffect(() => {
    let alive = true;
    const check = () =>
      void api<VoiceStatus>("GET", "/voice")
        .then((next) => alive && setStatus(next))
        .catch(() => {});
    check();
    const timer = downloading ? setInterval(check, 1000) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [downloading]);
  if (!status) return null;
  if (status.state === "ready") {
    return <p className="text-xs text-muted-foreground">Ready. Recordings are written out on this computer.</p>;
  }
  if (status.state === "unsupported") {
    return <p className="text-xs text-muted-foreground">Voice typing isn't available on this system yet.</p>;
  }
  if (downloading) {
    return (
      <p className="text-xs text-muted-foreground">
        Downloading the speech model · {Math.round(status.progress * 100)}%
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="flex-1 text-xs text-muted-foreground">
        {status.error ?? "The speech model (275 MB) downloads once, the first time you use voice typing."}
      </p>
      <Button size="sm" onClick={() => void api<VoiceStatus>("POST", "/voice/prepare").then(setStatus)}>
        {status.state === "failed" ? "Try again" : "Download now"}
      </Button>
    </div>
  );
}

export function GeneralSettings() {
  const state = useAppState();
  const preferences = state.preferences;
  const save = (change: Partial<Preferences>) => void api("PUT", "/preferences", change);
  const connectorNames = Object.fromEntries(
    state.connections.map((connection) => [connection.connectorId, connection.label]),
  );
  const [clientId, setClientId] = useState(state.google.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [savedGoogle, setSavedGoogle] = useState(false);

  return (
    <SettingsPage title="General">
      <Section title="Appearance">
        <Segmented
          label="Appearance"
          value={preferences.theme}
          onChange={(theme) => save({ theme })}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Section>

      <Section title="Advanced">
        <div className="space-y-4">
          <SwitchRow
            label="Send with Enter"
            description="Shift+Enter adds a new line"
            checked={preferences.sendWithEnter}
            onChange={(sendWithEnter) => save({ sendWithEnter })}
          />
          <SwitchRow
            label="Show tool activity"
            checked={preferences.showToolActivity}
            onChange={(showToolActivity) => save({ showToolActivity })}
          />
        </div>
      </Section>

      <Section title="Voice typing">
        <Field label="Language">
          <Select
            value={preferences.dictation}
            onChange={(event) => save({ dictation: event.target.value as DictationLanguage })}
          >
            {Object.entries(dictationLanguages).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <SpeechModel />
      </Section>

      <Section title="Action confirmations">
        <div className="flex flex-wrap gap-2">
          {presets
            .filter(
              (preset) =>
                !state.approvalRules.some(
                  (rule) => rule.target.kind === "category" && rule.target.category === preset.category,
                ),
            )
            .map((preset) => (
              <Button
                key={preset.category}
                onClick={() =>
                  void api("POST", "/approval-rules", {
                    target: { kind: "category", category: preset.category },
                    action: "require_approval",
                  })
                }
              >
                {preset.label}
              </Button>
            ))}
        </div>
        {state.approvalRules.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {state.approvalRules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="flex-1">{sentence(rule, connectorNames)}</span>
                <Button variant="ghost" size="sm" onClick={() => void api("DELETE", `/approval-rules/${rule.id}`)}>
                  <X className="size-3.5" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Google sign-in">
        <p className="text-xs text-muted-foreground">
          Needed for the YouTube integration. Create an OAuth client in Google Cloud and add this redirect URI to it.
        </p>
        <Field label="Authorized redirect URI">
          <Input
            readOnly
            value={state.google.redirectUri}
            onFocus={(event) => event.target.select()}
            className="font-mono text-xs"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client ID">
            <Input value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </Field>
          <Field label="Client secret">
            <Input
              type="password"
              autoComplete="off"
              value={clientSecret}
              placeholder={state.google.configured ? "Stored encrypted" : ""}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </Field>
        </div>
        <ErrorText error={googleError} />
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={() =>
              void api("PUT", "/google", { clientId, ...(clientSecret && { clientSecret }) })
                .then(() => {
                  setClientSecret("");
                  setSavedGoogle(true);
                })
                .catch((failure: Error) => setGoogleError(failure.message))
            }
          >
            Save
          </Button>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Get credentials <ExternalLink className="size-3" />
          </a>
          {savedGoogle ? <span className="text-xs text-success">Saved</span> : null}
        </div>
      </Section>

      <Section title="Computer">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Shell</dt>
          <dd>{state.environment.shell}</dd>
          <dt className="text-muted-foreground">Workspace</dt>
          <dd className="font-mono text-xs break-all">{state.environment.workspaceDir}</dd>
          <dt className="text-muted-foreground">Browser</dt>
          <dd>
            {state.environment.browser.channel}
            {state.environment.browser.headless ? ", headless" : ""}
          </dd>
          <dt className="text-muted-foreground">Screen</dt>
          <dd>{state.environment.computer.available ? state.environment.computer.driver : "Unavailable"}</dd>
        </dl>
      </Section>
    </SettingsPage>
  );
}
