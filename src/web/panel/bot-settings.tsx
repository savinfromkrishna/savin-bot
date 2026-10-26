import { Copy, Download, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Bot, BotPatch, Thinking, ToolGroup } from "../../shared/contracts.ts";
import { jobsLockedGroups, thinkingLevels, toolGroups } from "../../shared/ids.ts";
import { api, spacePath } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { toolGroupMeta } from "../lib/meta.ts";
import { activeModelLabel, choiceKey, connectedModels, fromKey, thinkingLabels, useCatalog } from "../lib/models.ts";
import { AvatarMark } from "../shell/avatar.tsx";
import { Button, Disclosure, ErrorText, Field, Input, Segmented, Select, SwitchRow, Textarea } from "../ui.tsx";
import { AvatarStudio } from "./avatar-studio.tsx";
import { Credentials } from "./credentials.tsx";
import { Knowledge } from "./knowledge.tsx";

function voices() {
  return "speechSynthesis" in window ? speechSynthesis.getVoices().map((voice) => voice.name) : [];
}

/** savin's bot settings: identity, notifications and computer up front; the rest under Advanced. */
export function BotSettings({ bot }: { bot: Bot }) {
  const state = useAppState();
  const [studio, setStudio] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<"name" | "title" | "description", string>>>({});
  const [instructions, setInstructions] = useState<string | null>(null);
  const [disabledInput, setDisabledInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const patch = (body: BotPatch) =>
    api("PUT", `/bots/${bot.id}`, body).catch((failure: Error) => setError(failure.message));
  const text = (key: "name" | "title" | "description") => draft[key] ?? bot[key];
  const blur = (key: "name" | "title" | "description") => {
    const value = draft[key];
    if (value !== undefined && value.trim() !== bot[key] && (key !== "name" || value.trim()))
      void patch({ [key]: value.trim() });
    setDraft((current) => ({ ...current, [key]: undefined }));
  };

  const catalog = useCatalog();
  const models = connectedModels(state.models, catalog);
  const defaultLabel = activeModelLabel(state.models, catalog);
  const instructionsDirty = instructions !== null && instructions !== bot.instructions;

  return (
    <div className="space-y-6 px-5 py-6">
      <div className="flex justify-center">
        <div className="relative">
          <button type="button" onClick={() => setStudio(!studio)} aria-label="Edit avatar" className="rounded-full">
            <AvatarMark avatar={bot.avatar} size={76} />
          </button>
          <span className="pointer-events-none absolute right-0 bottom-0 grid size-6 place-items-center rounded-full border border-border bg-card">
            <Pencil className="size-3" />
          </span>
          {studio ? (
            <AvatarStudio
              avatar={bot.avatar}
              onChange={(avatar) => void patch({ avatar })}
              onClose={() => setStudio(false)}
            />
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <Field label="Name">
          <Input
            value={text("name")}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            onBlur={() => blur("name")}
          />
        </Field>
        <Field label="Title">
          <Input
            value={text("title")}
            placeholder="e.g. Trends and analytics"
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            onBlur={() => blur("title")}
          />
        </Field>
        <Field label="Description">
          <Textarea
            rows={3}
            value={text("description")}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            onBlur={() => blur("description")}
          />
        </Field>
      </div>

      <SwitchRow
        label="Notifications"
        description="Get notified when this Bot finishes or needs input"
        checked={bot.notifications}
        onChange={(notifications) => {
          if (notifications && "Notification" in window && Notification.permission === "default")
            void Notification.requestPermission();
          void patch({ notifications });
        }}
      />

      <Field label="Computer">
        <Segmented
          wide
          label="Computer access"
          value={bot.computerAccess}
          onChange={(computerAccess) => void patch({ computerAccess })}
          options={[
            { value: "off", label: "Off" },
            { value: "ask", label: "Ask first" },
            { value: "full", label: "Full" },
          ]}
        />
      </Field>
      {state.space.kind === "jobs" && bot.computerAccess === "full" && bot.tools.browser ? (
        <SwitchRow
          label="Apply without asking"
          description={`Sends applications on job sites by itself, up to ${state.candidate.perDay} a day. Everything else still asks.`}
          checked={bot.autoApply}
          onChange={(autoApply) => void patch({ autoApply })}
        />
      ) : null}

      <Disclosure label="Advanced">
        <Field
          label={bot.instructionsAutomatic ? "Instructions · automatic" : "Instructions"}
          hint={
            bot.instructionsAutomatic ? null : (
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => void patch({ instructions: null })}
              >
                <RotateCcw className="size-3" /> Reset to automatic
              </button>
            )
          }
        >
          <Textarea
            rows={8}
            value={instructions ?? bot.instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {instructionsDirty ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setInstructions(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void patch({ instructions }).then(() => setInstructions(null))}>
              Save
            </Button>
          </div>
        ) : null}
        {bot.instructionHistory.length ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Instruction history
            </summary>
            <ul className="mt-2 space-y-1.5">
              {bot.instructionHistory.map((entry) => (
                <li key={entry.at} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {new Date(entry.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}{" "}
                    · {entry.reason}
                  </span>
                  <button
                    type="button"
                    className="ml-auto font-medium hover:underline"
                    onClick={() => void patch({ instructions: entry.text })}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {bot.computerAccess !== "off" ? (
          <div className="space-y-3">
            {toolGroups
              .filter(
                (group) => state.space.kind !== "jobs" || !(jobsLockedGroups as readonly string[]).includes(group),
              )
              .map((group: ToolGroup) => {
                const Icon = toolGroupMeta[group].icon;
                return (
                  <div key={group} className="flex items-center gap-3">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">
                      <SwitchRow
                        label={toolGroupMeta[group].label}
                        checked={bot.tools[group]}
                        onChange={(enabled) => void patch({ tools: { [group]: enabled } })}
                      />
                    </span>
                  </div>
                );
              })}
          </div>
        ) : null}
        <SwitchRow
          label="Delegation"
          description="Hand work to teammates"
          checked={bot.delegation}
          onChange={(delegation) => void patch({ delegation })}
        />

        <OpenWork bot={bot} />
        <Knowledge bot={bot} />

        <Field label="Model">
          <Select value={choiceKey(bot.model)} onChange={(event) => void patch({ model: fromKey(event.target.value) })}>
            <option value="">Default ({defaultLabel})</option>
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Thinking">
          <Select
            value={bot.thinking ?? ""}
            onChange={(event) => void patch({ thinking: (event.target.value || null) as Thinking | null })}
          >
            <option value="">Default ({thinkingLabels.medium})</option>
            {thinkingLevels
              .filter((level) => level !== "off")
              .map((level) => (
                <option key={level} value={level}>
                  {thinkingLabels[level]}
                </option>
              ))}
          </Select>
        </Field>

        <SwitchRow
          label="Read replies aloud"
          checked={bot.readAloud}
          onChange={(readAloud) => void patch({ readAloud })}
        />
        {bot.readAloud ? (
          <Field label="Voice">
            <Select value={bot.voice ?? ""} onChange={(event) => void patch({ voice: event.target.value || null })}>
              <option value="">Browser default</option>
              {voices().map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label="Disabled tools">
          <Input
            value={disabledInput}
            placeholder="Type a tool name, e.g. web_fetch, and press Enter"
            onChange={(event) => setDisabledInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !disabledInput.trim()) return;
              void patch({ disabledTools: [...new Set([...bot.disabledTools, disabledInput.trim()])] });
              setDisabledInput("");
            }}
          />
        </Field>
        {bot.disabledTools.length ? (
          <div className="flex flex-wrap gap-1.5">
            {bot.disabledTools.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full bg-muted py-1 pr-1 pl-2.5 font-mono text-xs"
              >
                {name}
                <button
                  type="button"
                  aria-label={`Enable ${name}`}
                  className="grid size-5 place-items-center rounded-full hover:bg-input"
                  onClick={() => void patch({ disabledTools: bot.disabledTools.filter((tool) => tool !== name) })}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <Credentials bot={bot} />
      </Disclosure>

      <ErrorText error={error} />
      <div className="flex flex-wrap gap-2 border-t border-border pt-5">
        <a
          href={spacePath(`/bots/${bot.id}/export`)}
          download
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-muted"
        >
          <Download className="size-3.5" /> Export
        </a>
        <DuplicateBot bot={bot} />
        <ClearConversation bot={bot} />
        <DeleteBot bot={bot} />
      </div>
    </div>
  );
}

function DuplicateBot({ bot }: { bot: Bot }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      onClick={() =>
        void api<Bot>("POST", `/bots/${bot.id}/duplicate`).then((copy) => navigate(`/app/bots/${copy.id}`))
      }
    >
      <Copy className="size-3.5" /> Duplicate
    </Button>
  );
}

/** savin's delete: the conversation and routines go with the bot. */
function DeleteBot({ bot }: { bot: Bot }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="w-full space-y-2 rounded-xl border border-destructive/40 p-3">
      <p className="text-[13px] font-medium">Delete {bot.name}?</p>
      <p className="text-xs text-muted-foreground">Its conversation and routines will be permanently deleted.</p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          onClick={() => void api("DELETE", `/bots/${bot.id}`).then(() => navigate("/app", { replace: true }))}
        >
          Delete
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  ) : (
    <Button variant="danger" onClick={() => setConfirming(true)}>
      <Trash2 className="size-3.5" /> Delete
    </Button>
  );
}

function ClearConversation({ bot }: { bot: Bot }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="flex items-center gap-2">
      <Button
        variant="danger"
        onClick={() => void api("POST", `/bots/${bot.id}/clear`).then(() => setConfirming(false))}
      >
        Clear
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  ) : (
    <Button variant="ghost" onClick={() => setConfirming(true)}>
      Clear conversation
    </Button>
  );
}

function OpenWork({ bot }: { bot: Bot }) {
  const [item, setItem] = useState("");
  const add = () => {
    if (!item.trim()) return;
    void api("POST", `/bots/${bot.id}/open-work`, { text: item.trim() });
    setItem("");
  };
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Open work</p>
      {bot.openWork.length ? (
        <ul className="space-y-1">
          {bot.openWork.map((entry) => (
            <li
              key={entry.id}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted"
            >
              <span className={entry.parked ? "flex-1 text-muted-foreground line-through" : "flex-1"}>
                {entry.text}
              </span>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => void api("PATCH", `/bots/${bot.id}/open-work/${entry.id}`, { parked: !entry.parked })}
              >
                {entry.parked ? "Open" : "Park"}
              </button>
              <button
                type="button"
                aria-label={`Remove ${entry.text}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void api("DELETE", `/bots/${bot.id}/open-work/${entry.id}`)}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">None yet</p>
      )}
      <div className="flex gap-2">
        <Input
          value={item}
          placeholder="Add item"
          onChange={(event) => setItem(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
        <Button onClick={add}>Add</Button>
      </div>
    </div>
  );
}
