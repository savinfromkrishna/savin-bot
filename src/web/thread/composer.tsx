import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Bot, Group, Run } from "../../shared/contracts.ts";
import { api, uploadFile } from "../lib/api.ts";
import { useDictation } from "../lib/dictation.ts";
import { useAppState } from "../lib/live.tsx";
import { attachmentName, isLive } from "../lib/meta.ts";
import { cx, Spinner } from "../ui.tsx";

/** A paste this long goes along as an attached file, so the chat stays readable and the bot gets it whole. */
const PASTE_AS_FILE = 2000;
/** The longest message the API takes; a longer one is attached as a file too. */
const MESSAGE_LIMIT = 8000;

/** Minutes and seconds, as a recording shows them. */
const elapsed = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Saves text to the inbox as a Markdown file and returns its workspace path. */
function saveText(text: string) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return uploadFile(`inbox/pasted-${stamp}.md`, new File([text], `pasted-${stamp}.md`, { type: "text/markdown" }));
}

/** Writes to one bot, or to a group chat when `group` is given. */
export function Composer({ bot, group, runs, compact }: { bot?: Bot; group?: Group; runs: Run[]; compact?: boolean }) {
  const state = useAppState();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const typed = useRef(text);
  typed.current = text;
  const name = group?.name ?? bot?.name ?? "";

  /** Types spoken words where the cursor is, spaced from the words around them. */
  const dictation = useDictation((spoken) => {
    const current = typed.current;
    const start = field.current?.selectionStart ?? current.length;
    const end = field.current?.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^[\s.,!?;:]/.test(after) ? " " : "";
    setText(`${before}${lead}${spoken}${trail}${after}`);
    const caret = before.length + lead.length + spoken.length;
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(caret, caret);
    });
  });
  const listening = dictation.state.phase === "listening";
  const live = runs.filter((run) =>
    group
      ? run.groupId === group.id && isLive(run)
      : run.botId === bot?.id && run.parentRunId === null && !run.groupId && isLive(run),
  );

  const ready = Boolean(text.trim() || attachments.length) && !busy && !uploading;

  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      let message = text.trim();
      let files = attachments;
      if (message.length > MESSAGE_LIMIT) {
        files = [...files, await saveText(message)];
        message = "";
      }
      message ||= "Read what I attached.";
      if (group) await api("POST", `/groups/${group.id}/messages`, { text: message, attachments: files });
      else await api("POST", "/runs", { botId: bot?.id, task: message, attachments: files });
      setText("");
      setAttachments([]);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (work: () => Promise<string[]>) => {
    setUploading(true);
    setError(null);
    try {
      const paths = await work();
      setAttachments((current) => [...current, ...paths]);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const attach = (files: FileList | null) => {
    if (!files?.length) return;
    const stamp = new Date().toISOString().slice(0, 10);
    void upload(() => Promise.all([...files].map((file) => uploadFile(`inbox/${stamp}-${file.name}`, file))));
  };

  return (
    <div>
      {attachments.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((path) => (
            <span
              key={path}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-1 pr-1 pl-2.5 text-xs"
            >
              {attachmentName(path)}
              <button
                type="button"
                aria-label={`Remove ${path}`}
                className="grid size-5 place-items-center rounded-full hover:bg-muted"
                onClick={() => setAttachments((current) => current.filter((item) => item !== path))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div
        className={cx(
          "flex items-end gap-1.5 rounded-[26px] border border-input bg-card p-1.5 shadow-sm focus-within:border-foreground/40",
          compact && "shadow-lg",
        )}
      >
        <input ref={picker} type="file" multiple hidden onChange={(event) => attach(event.target.files)} />
        <button
          type="button"
          aria-label="Attach files"
          onClick={() => picker.current?.click()}
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {uploading ? <Spinner /> : <Paperclip className="size-4" />}
        </button>
        <textarea
          ref={field}
          aria-label={`Message ${name}`}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text/plain");
            if (pasted.length < PASTE_AS_FILE) return;
            event.preventDefault();
            void upload(async () => [await saveText(pasted)]);
          }}
          onKeyDown={(event) => {
            if (event.key === " " && event.ctrlKey && event.shiftKey) {
              event.preventDefault();
              dictation.toggle();
              return;
            }
            // While listening, Enter finishes speaking instead of sending.
            if (listening && event.key === "Enter") {
              event.preventDefault();
              dictation.stop();
              return;
            }
            const sends = state.preferences.sendWithEnter
              ? event.key === "Enter" && !event.shiftKey
              : event.key === "Enter" && (event.ctrlKey || event.metaKey);
            if (sends) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={group ? `Message ${name} · @name picks who answers` : `Message ${name}`}
          className="field-sizing-content max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[14px] leading-5 outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label={listening ? "Stop voice typing" : "Voice typing"}
          aria-pressed={listening}
          title={listening ? "Finish (Enter)" : "Voice typing (Ctrl+Shift+Space)"}
          disabled={dictation.state.phase === "transcribing"}
          onClick={dictation.toggle}
          // A ring that grows with the voice shows the microphone is hearing it.
          style={
            dictation.state.phase === "listening"
              ? {
                  boxShadow: `0 0 0 ${2 + Math.round(dictation.state.level * 8)}px color-mix(in oklab, var(--destructive) 20%, transparent)`,
                }
              : undefined
          }
          className={cx(
            "grid size-9 shrink-0 place-items-center rounded-full transition-[box-shadow,background-color]",
            listening
              ? "bg-destructive/10 text-destructive"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {dictation.state.phase === "transcribing" ? (
            <Spinner />
          ) : listening ? (
            <Square className="size-3.5 fill-current" />
          ) : (
            <Mic className="size-4" />
          )}
        </button>
        {live.length && !text.trim() && !attachments.length ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={() => {
              for (const run of live) void api("POST", `/runs/${run.id}/cancel`);
            }}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-muted hover:bg-input"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={!ready}
            onClick={() => void send()}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition disabled:opacity-30"
          >
            {busy ? <Spinner /> : <ArrowUp className="size-4" />}
          </button>
        )}
      </div>
      {dictation.state.phase === "listening" ? (
        <p className="mt-1.5 flex items-center gap-1.5 px-3 text-xs text-muted-foreground" aria-live="polite">
          <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
          Listening {elapsed(dictation.state.seconds)} · Esc to cancel
        </p>
      ) : dictation.state.phase === "transcribing" ? (
        <p className="mt-1.5 px-3 text-xs text-muted-foreground" aria-live="polite">
          {dictation.state.setup === null
            ? "Writing it out…"
            : `Downloading the speech model, once · ${Math.round(dictation.state.setup * 100)}%`}
        </p>
      ) : (error ?? dictation.error) ? (
        <p className="mt-1.5 px-3 text-xs text-destructive">{error ?? dictation.error}</p>
      ) : null}
    </div>
  );
}
