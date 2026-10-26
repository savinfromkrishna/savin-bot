import { KeyRound, Plus, X } from "lucide-react";
import { useState } from "react";
import type { Bot, CredentialType } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";
import { Button, ErrorText, Field, Input, Select } from "../ui.tsx";

const types: Record<
  CredentialType,
  { label: string; fields: { key: string; label: string; secret?: boolean; placeholder?: string }[] }
> = {
  bearer: {
    label: "Bearer token",
    fields: [
      { key: "domain", label: "Domain", placeholder: "api.example.com" },
      { key: "token", label: "Token", secret: true },
    ],
  },
  header: {
    label: "Custom header",
    fields: [
      { key: "domain", label: "Domain", placeholder: "api.example.com" },
      { key: "header", label: "Header name", placeholder: "x-api-key" },
      { key: "value", label: "Value", secret: true },
    ],
  },
  basic: {
    label: "Basic auth",
    fields: [
      { key: "domain", label: "Domain", placeholder: "api.example.com" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", secret: true },
    ],
  },
  login: {
    label: "Website login",
    fields: [
      { key: "domain", label: "Website", placeholder: "instagram.com" },
      { key: "username", label: "Username or email" },
      { key: "password", label: "Password", secret: true },
    ],
  },
  variable: {
    label: "Command variable",
    fields: [
      { key: "name", label: "Name", placeholder: "YOUTUBE_API_KEY" },
      { key: "value", label: "Value", secret: true },
    ],
  },
};

/** Secrets a bot uses without ever seeing them: headers by domain, website logins, shell variables. */
export function Credentials({ bot }: { bot: Bot }) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<CredentialType>("bearer");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      await api("POST", `/bots/${bot.id}/credentials`, { type, ...values });
      setAdding(false);
      setValues({});
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Credentials</p>
      {bot.credentials.map((credential) => (
        <div key={credential.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted">
          <KeyRound className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {credential.type === "variable" ? (
              <span className="font-mono">${credential.target}</span>
            ) : (
              credential.target
            )}
            <span className="text-muted-foreground">
              {" "}
              · {credential.type === "variable" ? "Command variable" : credential.detail}
            </span>
          </span>
          <button
            type="button"
            aria-label="Remove credential"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void api("DELETE", `/bots/${bot.id}/credentials/${credential.id}`)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {adding ? (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <Field label="Type">
            <Select
              value={type}
              onChange={(event) => {
                setType(event.target.value as CredentialType);
                setValues({});
              }}
            >
              {Object.entries(types).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </Select>
          </Field>
          {types[type].fields.map((field) => (
            <Field key={field.key} label={field.label}>
              <Input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              />
            </Field>
          ))}
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" /> Add credential
        </Button>
      )}
    </div>
  );
}
