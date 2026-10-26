import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { AppState, ModelProviderView, Thinking } from "../../shared/contracts.ts";
import { COMPATIBLE } from "../../shared/providers.ts";
import { api } from "../lib/api.ts";
import { thinkingLabels } from "../lib/models.ts";
import { Button, ErrorText, Field, Input, Select, SwitchRow } from "../ui.tsx";
import { useSignIn } from "./use-sign-in.ts";

type Variant = "settings" | "onboarding";

const minutes = (seconds: number) => {
  const count = Math.max(1, Math.ceil(seconds / 60));
  return `${count} minute${count === 1 ? "" : "s"}`;
};

/** A model list; long ones (OpenRouter has hundreds) get a filter. */
function ModelPicker({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = query.trim()
    ? options.filter((option) => `${option.id} ${option.label}`.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  return (
    <div className="space-y-2">
      {options.length > 20 ? (
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" />
      ) : null}
      <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Model">
        {shown.some((option) => option.id === value) ? null : (
          <option value={value}>{options.find((option) => option.id === value)?.label ?? value}</option>
        )}
        {shown.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function SignInCard({ sign }: { sign: ReturnType<typeof useSignIn> }) {
  const { begin, popupBlocked } = sign;
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  if (!begin) return null;
  const link = (
    <a href={begin.verificationUri} target="_blank" rel="noreferrer" className="text-foreground underline">
      {begin.mode === "auth-url"
        ? new URL(begin.verificationUri).hostname
        : begin.verificationUri.replace(/^https:\/\//, "")}
    </a>
  );
  return (
    <div className="space-y-3 rounded-xl border border-border px-4 py-3">
      {begin.mode === "auth-url" ? (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {popupBlocked ? (
              <>Open {link} to finish signing in.</>
            ) : (
              <>Finish signing in at {link}. The final page may not load; paste its URL or code here.</>
            )}
          </p>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-label="Authorization code or callback URL"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:53692/callback?code=…"
            />
            <Button disabled={!code.trim()} onClick={() => void sign.submit(code).then(() => setCode(""))}>
              Submit
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Waiting for sign-in — the link expires in about {minutes(begin.expiresInSeconds)}.
          </p>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {popupBlocked ? (
              <>Open {link} and enter this code:</>
            ) : (
              <>A sign-in tab opened at {link}. Enter this code there — this window keeps waiting:</>
            )}
          </p>
          <div className="flex items-center gap-3">
            <p className="font-mono text-[22px] tracking-[0.2em]">{begin.userCode}</p>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(begin.userCode).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Waiting for sign-in — the code expires in about {minutes(begin.expiresInSeconds)}.
          </p>
        </>
      )}
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={sign.cancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Your own OpenAI-compatible server: its address, the models found on it, and an optional key. */
function ServerForm({ models, onDone }: { models: AppState["models"]; onDone: (message: string) => void }) {
  const saved = models.connections.find((entry) => entry.provider === COMPATIBLE)?.server;
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [found, setFound] = useState<string[]>(saved?.models ?? []);
  const [model, setModel] = useState(
    models.active?.providerId === COMPATIBLE ? models.active.model : (saved?.models[0] ?? ""),
  );
  const [other, setOther] = useState(false);
  const [reasoning, setReasoning] = useState(saved?.reasoning ?? false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"find" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    setBusy("find");
    setError(null);
    try {
      const result = await api<{ models: string[] }>("POST", "/models/test", {
        provider: COMPATIBLE,
        baseUrl: baseUrl.trim(),
        ...(apiKey && { apiKey }),
      });
      setFound(result.models);
      if (!model || !result.models.includes(model)) setModel(result.models[0] ?? "");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await api("POST", "/models/connect", {
        provider: COMPATIBLE,
        baseUrl: baseUrl.trim(),
        models: found,
        model: model.trim(),
        reasoning,
        ...(apiKey && { apiKey }),
      });
      setApiKey("");
      onDone("Saved.");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const picking = found.length > 0 && !other && (found.includes(model) || !model);
  return (
    <div className="space-y-4">
      <Field label="Server URL">
        <div className="flex gap-2">
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            autoComplete="off"
            spellCheck={false}
          />
          <Button busy={busy === "find"} disabled={!baseUrl.trim() || busy !== null} onClick={() => void find()}>
            {busy === "find" ? "Finding…" : "Find models"}
          </Button>
        </div>
      </Field>
      <Field label="Model">
        {picking ? (
          <Select
            value={model}
            onChange={(event) => {
              if (event.target.value === "") setOther(true);
              else setModel(event.target.value);
            }}
          >
            {found.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            <option value="">Other model…</option>
          </Select>
        ) : (
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="exact-model-id"
            spellCheck={false}
          />
        )}
      </Field>
      <SwitchRow label="Supports thinking" checked={reasoning} onChange={setReasoning} />
      <details className="text-[13px] text-muted-foreground">
        <summary className="w-fit cursor-pointer select-none">API key</summary>
        <Input
          className="mt-2"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={saved ? "Paste a replacement key" : "Optional"}
          aria-label="API key"
        />
      </details>
      <ErrorText error={error} />
      <Button
        variant="primary"
        busy={busy === "save"}
        disabled={!baseUrl.trim() || !model.trim() || busy !== null}
        onClick={() => void save()}
      >
        {busy === "save" ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

/**
 * One provider, savin's way: its model and thinking, subscription sign-in when it has one,
 * an API key otherwise (or as well), and its connection once made.
 */
export function ConnectForm({
  provider,
  models,
  variant = "settings",
  onDone,
}: {
  provider: ModelProviderView;
  models: AppState["models"];
  variant?: Variant;
  onDone: (message: string) => void;
}) {
  const connection = models.connections.find((entry) => entry.provider === provider.id);
  const usingThis = models.active?.providerId === provider.id;
  const [modelId, setModelId] = useState((usingThis && models.active?.model) || provider.models[0]?.id || "");
  const [thinking, setThinking] = useState<Thinking | null>(usingThis ? models.thinking : null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"connect" | "test" | "use" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const model = provider.models.find((entry) => entry.id === modelId);
  const label = model?.label ?? modelId;
  const sign = useSignIn(() => onDone(`Connected and using ${label}.`));
  const active = usingThis && models.active?.model === modelId && (models.thinking ?? null) === (thinking ?? null);
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    setTested(null);
    try {
      await work();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (provider.id === COMPATIBLE) return <ServerForm models={models} onDone={onDone} />;

  const connectKey = () =>
    run("connect", async () => {
      await api("POST", "/models/connect", { provider: provider.id, apiKey: apiKey.trim(), model: modelId, thinking });
      setApiKey("");
      onDone(`Connected and using ${label}.`);
    });

  return (
    <div className="space-y-5">
      {connection ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[14px] font-medium">Connected · {connection.label}</p>
            <p className="text-xs text-muted-foreground">Stored securely. Never shown here.</p>
          </div>
          <Button variant="ghost" className="-mr-2 text-muted-foreground" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      ) : variant === "settings" ? (
        <p className="text-[13px] text-muted-foreground">Connect this provider to use it as your model.</p>
      ) : null}

      {confirming ? (
        <div className="space-y-2 rounded-xl border border-destructive/40 p-3">
          <p className="text-[13px] font-medium">Disconnect {provider.name}?</p>
          <p className="text-xs text-muted-foreground">This removes the connection from every space.</p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              busy={busy === "disconnect"}
              onClick={() =>
                void run("disconnect", async () => {
                  sign.cancel();
                  await api("DELETE", `/models/connections/${provider.id}`);
                  setConfirming(false);
                  onDone(`Disconnected ${provider.name}.`);
                })
              }
            >
              Disconnect
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {provider.models.length ? (
        <Field label="Model">
          <ModelPicker options={provider.models} value={modelId} onChange={setModelId} />
        </Field>
      ) : null}
      {model?.thinking.length ? (
        <Field label="Thinking">
          <Select
            value={thinking ?? ""}
            onChange={(event) => setThinking((event.target.value || null) as Thinking | null)}
          >
            <option value="">Default ({thinkingLabels.medium})</option>
            {model.thinking.map((level) => (
              <option key={level} value={level}>
                {thinkingLabels[level]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {provider.billing ? <p className="text-[13px] text-muted-foreground">{provider.billing}</p> : null}

      {connection && !active ? (
        <Button
          variant="primary"
          busy={busy === "use"}
          onClick={() =>
            void run("use", async () => {
              await api("PUT", "/models/active", { choice: { providerId: provider.id, model: modelId }, thinking });
              onDone(usingThis ? "Saved." : `Now using ${label}.`);
            })
          }
        >
          {busy === "use" ? "Switching…" : usingThis ? "Save" : "Use this model"}
        </Button>
      ) : null}

      <div className={connection ? "space-y-5 border-t border-border pt-5" : "space-y-5"}>
        {provider.signIn ? (
          <div className="space-y-3">
            {sign.begin ? (
              <SignInCard sign={sign} />
            ) : (
              <Button
                variant={connection ? "outline" : "primary"}
                busy={sign.pending}
                onClick={() => void sign.start({ provider: provider.id, model: modelId, thinking })}
              >
                {sign.pending ? "Starting…" : connection?.auth === "oauth" ? "Sign in again" : provider.signIn.label}
              </Button>
            )}
            {connection?.auth === "oauth" ? (
              <Button
                busy={busy === "test"}
                onClick={() =>
                  void run("test", async () => {
                    await api("POST", "/models/test", { provider: provider.id });
                    setTested("A subscription credential is stored securely.");
                  })
                }
              >
                {busy === "test" ? "Testing…" : "Test sign-in"}
              </Button>
            ) : null}
            <ErrorText error={sign.error} />
          </div>
        ) : null}

        {provider.apiKey ? (
          <div className="space-y-3">
            <Field
              label={
                connection
                  ? "Replace API key"
                  : provider.signIn
                    ? variant === "onboarding"
                      ? "Or paste an API key"
                      : "Or connect an API key"
                    : "API key"
              }
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={connection ? "Paste a replacement key" : "sk-…"}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {provider.keyTest ? (
                <Button
                  busy={busy === "test"}
                  disabled={apiKey.trim().length < 8 || busy !== null}
                  onClick={() =>
                    void run("test", async () => {
                      const result = await api<{ models: string[] }>("POST", "/models/test", {
                        provider: provider.id,
                        apiKey: apiKey.trim(),
                      });
                      setTested(`The key works · ${result.models.length} models available.`);
                    })
                  }
                >
                  {busy === "test" ? "Testing…" : "Test API key"}
                </Button>
              ) : null}
              <Button
                variant={connection ? "outline" : "primary"}
                busy={busy === "connect"}
                disabled={apiKey.trim().length < 8 || busy !== null}
                onClick={() => void connectKey()}
              >
                {busy === "connect"
                  ? "Saving…"
                  : variant === "onboarding"
                    ? "Continue"
                    : connection
                      ? "Replace API key"
                      : "Connect API key"}
              </Button>
            </div>
          </div>
        ) : null}
        {tested ? <p className="text-xs text-success">{tested}</p> : null}
        <ErrorText error={error} />
      </div>
    </div>
  );
}
