import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type { AppState } from "../../shared/contracts.ts";
import { Loading } from "../lib/account.tsx";
import { api } from "../lib/api.ts";
import { useCatalog } from "../lib/models.ts";
import { ConnectForm } from "../models/connect-form.tsx";
import { Logo } from "../shell/logo.tsx";
import { Field, Select } from "../ui.tsx";

/**
 * savin's first run: connect a model, then straight into the space. The team was set up with the
 * account, so there is nothing else to configure first.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const catalog = useCatalog();
  const [models, setModels] = useState<AppState["models"] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void api<AppState>("GET", "/state").then((state) => setModels(state.models));
  }, []);

  if (!catalog || !models) return <Loading />;
  if (done || models.active) return <Navigate to="/app" replace />;
  // The catalog lists the subscription sign-ins first, so a new account starts on ChatGPT.
  const current = catalog.find((entry) => entry.id === provider) ?? catalog[0];

  return (
    <main className="h-full overflow-y-auto bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-md">
        <Logo className="size-10" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Connect a model</h1>
        <div className="mt-8 space-y-5">
          <Field label="Provider">
            <Select value={current?.id} onChange={(event) => setProvider(event.target.value)}>
              {catalog.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
          {current ? (
            <ConnectForm
              key={current.id}
              provider={current}
              models={models}
              variant="onboarding"
              onDone={() => setDone(true)}
            />
          ) : null}
        </div>
        <button
          type="button"
          className="mt-10 text-[13px] text-muted-foreground hover:text-foreground"
          onClick={() => navigate("/app", { replace: true })}
        >
          Skip for now
        </button>
      </div>
    </main>
  );
}
