import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Bot, SpaceSummary } from "../../shared/contracts.ts";
import { useAccount } from "../lib/account.tsx";
import { accountApi, api } from "../lib/api.ts";
import { Button, Dialog, DialogClose, ErrorText, Field, Input, Segmented, Textarea } from "../ui.tsx";

function DialogForm({
  title,
  onClose,
  onSubmit,
  error,
  children,
  submit,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  error: string | null;
  children: ReactNode;
  submit: ReactNode;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <DialogClose onClose={onClose} />
        </div>
        <div className="space-y-4 px-5 py-5">
          {children}
          <ErrorText error={error} />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {submit}
        </div>
      </form>
    </Dialog>
  );
}

/** savin's "New bot": a name, what it does and what it is for. The rest is set up automatically. */
export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { refresh } = useAccount();
  const [form, setForm] = useState({ name: "", title: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bot = await api<Bot>("POST", "/bots", form);
      void refresh();
      onClose();
      navigate(`/app/bots/${bot.id}`);
    } catch (failure) {
      setError((failure as Error).message || "Could not create bot");
      setBusy(false);
    }
  };
  return (
    <DialogForm
      title="New bot"
      onClose={onClose}
      onSubmit={submit}
      error={error}
      submit={
        <Button type="submit" variant="primary" busy={busy} disabled={!form.name.trim()}>
          {busy ? "Creating…" : "Create"}
        </Button>
      }
    >
      <Field label="Name">
        <Input
          autoFocus
          maxLength={80}
          value={form.name}
          placeholder="Name this bot"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </Field>
      <Field label="Title">
        <Input
          maxLength={500}
          value={form.title}
          placeholder="Describe what this bot does"
          onChange={(event) => setForm({ ...form, title: event.target.value })}
        />
      </Field>
      <Field label="Description">
        <Textarea
          rows={4}
          maxLength={4000}
          value={form.description}
          placeholder="What this bot is for"
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </Field>
    </DialogForm>
  );
}

/** "New space": a private workspace with its own bots, brand, apps and computer. */
export function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { refresh, switchSpace } = useAccount();
  const [name, setName] = useState("");
  const [team, setTeam] = useState<"team" | "jobs" | "empty">("team");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const space = await accountApi<SpaceSummary>("POST", "/spaces", {
        name,
        team: team !== "empty",
        kind: team === "jobs" ? "jobs" : "social",
      });
      await refresh();
      switchSpace(space.id);
      onClose();
      navigate("/app");
    } catch (failure) {
      setError((failure as Error).message || "Could not create space");
      setBusy(false);
    }
  };
  return (
    <DialogForm
      title="New space"
      onClose={onClose}
      onSubmit={submit}
      error={error}
      submit={
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
          {busy ? "Creating…" : "Create space"}
        </Button>
      }
    >
      <Field label="Name">
        <Input
          autoFocus
          maxLength={60}
          value={name}
          placeholder="Second channel"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Start with">
        <Segmented
          wide
          label="Start with"
          value={team}
          onChange={setTeam}
          options={[
            { value: "team", label: "Social media team" },
            { value: "jobs", label: "Job search team" },
            { value: "empty", label: "No bots" },
          ]}
        />
      </Field>
    </DialogForm>
  );
}

export function RenameSpaceDialog({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  const { refresh } = useAccount();
  const [name, setName] = useState(space.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await accountApi("PATCH", `/spaces/${space.id}`, { name });
      await refresh();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <DialogForm
      title="Rename space"
      onClose={onClose}
      onSubmit={submit}
      error={error}
      submit={
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
          Save
        </Button>
      }
    >
      <Field label="Name">
        <Input autoFocus maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
    </DialogForm>
  );
}

export function DeleteSpaceDialog({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  const navigate = useNavigate();
  const { me, refresh, switchSpace } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await accountApi("DELETE", `/spaces/${space.id}`);
      const home = me.spaces.find((other) => other.isDefault);
      if (home) switchSpace(home.id);
      await refresh();
      onClose();
      navigate("/app");
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <DialogForm
      title={`Delete ${space.name}?`}
      onClose={onClose}
      onSubmit={submit}
      error={error}
      submit={
        <Button type="submit" variant="danger" busy={busy}>
          Delete
        </Button>
      }
    >
      <p className="text-[13px] text-muted-foreground">
        Its bots, conversations, files and routines will be permanently deleted.
      </p>
    </DialogForm>
  );
}
