import { Download, Plus } from "lucide-react";
import { useState } from "react";
import type { Bot } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { MarkdownText } from "../thread/blocks.tsx";
import { Button, ErrorText, Tabs, Textarea } from "../ui.tsx";

const template = `---
name: new-skill
description: One sentence on when to use this skill.
---

# Steps

1.
`;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}

function Memory({ bot }: { bot: Bot }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    return (
      <div className="space-y-2">
        <Textarea rows={8} value={editing} onChange={(event) => setEditing(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void api("PUT", `/bots/${bot.id}/memory`, { text: editing }).then(() => setEditing(null))}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {bot.memory.text ? (
        <div className="rounded-xl bg-muted px-3 py-2.5 text-[13px]">
          <MarkdownText text={bot.memory.text} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing remembered yet</p>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {bot.memory.revision ? <span>rev {bot.memory.revision}</span> : null}
        <button type="button" className="ml-auto hover:text-foreground" onClick={() => setEditing(bot.memory.text)}>
          Edit
        </button>
        {bot.memory.text ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => download(`${bot.name}-memory.md`, bot.memory.text)}
          >
            <Download className="size-3" /> Download as markdown
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SharedSkills() {
  const state = useAppState();
  const [editing, setEditing] = useState<{ name: string | null; content: string; builtIn: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (name: string, builtIn: boolean) => {
    const skill = await api<{ content: string }>("GET", `/skills/${encodeURIComponent(name)}`);
    setEditing({ name, content: skill.content, builtIn });
    setConfirm(false);
    setError(null);
  };
  const save = async () => {
    if (!editing) return;
    try {
      await api("PUT", "/skills", {
        content: editing.content,
        previousName: editing.builtIn ? undefined : (editing.name ?? undefined),
      });
      setEditing(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  if (editing) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">SKILL.md</p>
        <Textarea
          rows={12}
          className="font-mono text-xs"
          value={editing.content}
          onChange={(event) => setEditing({ ...editing, content: event.target.value })}
        />
        <ErrorText error={error} />
        <div className="flex items-center gap-2">
          {editing.name && !editing.builtIn ? (
            confirm ? (
              <Button
                variant="danger"
                onClick={() =>
                  void api("DELETE", `/skills/${encodeURIComponent(editing.name ?? "")}`).then(() => setEditing(null))
                }
              >
                Confirm delete
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirm(true)}>
                Delete
              </Button>
            )
          ) : null}
          <Button variant="ghost" className="ml-auto" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {state.skills.map((skill) => (
        <button
          key={skill.name}
          type="button"
          onClick={() => void open(skill.name, skill.builtIn)}
          className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-xs font-medium">{skill.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
          </span>
          {skill.builtIn ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              Built-in
            </span>
          ) : null}
        </button>
      ))}
      <Button variant="ghost" onClick={() => setEditing({ name: null, content: template, builtIn: false })}>
        <Plus className="size-3.5" /> New skill
      </Button>
    </div>
  );
}

export function Knowledge({ bot }: { bot: Bot }) {
  const [tab, setTab] = useState<"memory" | "skills">("memory");
  return (
    <div className="space-y-3">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "memory", label: "Memory" },
          { value: "skills", label: "Shared skills" },
        ]}
      />
      {tab === "memory" ? <Memory bot={bot} /> : <SharedSkills />}
    </div>
  );
}
