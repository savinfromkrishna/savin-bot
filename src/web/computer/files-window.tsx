import { ArrowLeft, Download, File, FileText, Folder, FolderPlus, Trash2, Upload } from "lucide-react";
import type { DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "../../shared/contracts.ts";
import { api, fileUrl, uploadFile } from "../lib/api.ts";
import { useLive } from "../lib/live.tsx";
import { ago, sizeLabel } from "../lib/meta.ts";
import { Button, cx, Spinner } from "../ui.tsx";

const kindOf = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (
    [
      "md",
      "txt",
      "json",
      "csv",
      "srt",
      "vtt",
      "html",
      "css",
      "js",
      "ts",
      "py",
      "sh",
      "yml",
      "yaml",
      "log",
      "xml",
    ].includes(ext) ||
    !ext.length
  )
    return "text";
  return "other";
};

function Preview({ entry }: { entry: FileEntry }) {
  const kind = kindOf(entry.name);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== "text") return;
    if (entry.size > 2_000_000) return setText("This file is too large to preview.");
    void fetch(fileUrl(entry.path))
      .then((response) => response.text())
      .then(setText);
  }, [entry, kind]);
  if (kind === "image")
    return <img src={fileUrl(entry.path)} alt={entry.name} className="mx-auto max-h-full max-w-full object-contain" />;
  // biome-ignore lint/a11y/useMediaCaption: previews of the person\'s own files have no captions
  if (kind === "video") return <video src={fileUrl(entry.path)} controls className="mx-auto max-h-full max-w-full" />;
  // biome-ignore lint/a11y/useMediaCaption: previews of the person\'s own files have no captions
  if (kind === "audio") return <audio src={fileUrl(entry.path)} controls className="mx-auto mt-8 w-full" />;
  if (kind === "pdf") return <iframe src={fileUrl(entry.path)} title={entry.name} className="h-full w-full" />;
  if (kind === "text") {
    return text === null ? (
      <Spinner className="m-4" />
    ) : (
      <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
    );
  }
  return (
    <div className="grid h-full place-items-center">
      <a href={fileUrl(entry.path, true)} className="text-[13px] underline underline-offset-2">
        Download {entry.name}
      </a>
    </div>
  );
}

/** The shared workspace: browse, preview, download and add files. */
export function FilesPanel() {
  const { filesVersion } = useLive();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<FileEntry[]>("GET", `/files?path=${encodeURIComponent(path)}`)
      .then((list) => {
        setEntries(list);
        setError(null);
      })
      .catch((failure: Error) => setError(failure.message));
  }, [path, filesVersion]);

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const file of files) await uploadFile(path ? `${path}/${file.name}` : file.name, file);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const crumbs = path ? path.split("/") : [];
  const up = () => setPath(crumbs.slice(0, -1).join("/"));

  if (preview) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Back" onClick={() => setPreview(null)}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{preview.name}</span>
          <a
            href={fileUrl(preview.path, true)}
            aria-label="Download"
            className="grid size-7 place-items-center rounded-lg hover:bg-muted"
          >
            <Download className="size-3.5" />
          </a>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/40">
          <Preview entry={preview} />
        </div>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the list is also a drop target for uploads
    <div
      className="flex h-full flex-col"
      onDragOver={(event: DragEvent) => event.preventDefault()}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {path ? (
          <Button variant="ghost" size="icon" className="size-7" aria-label="Back" onClick={up}>
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">~/{path}</span>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => event.target.files && void upload(event.target.files)}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Upload"
          onClick={() => picker.current?.click()}
        >
          {busy ? <Spinner /> : <Upload className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="New folder"
          onClick={() => {
            const name = window.prompt("Folder name")?.trim();
            if (name) void api("POST", "/files/mkdir", { path: path ? `${path}/${name}` : name });
          }}
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      {error ? <p className="px-3 py-1.5 text-xs text-destructive">{error}</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {entries === null ? <Spinner className="m-3" /> : null}
        {entries?.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">Empty folder</li>
        ) : null}
        {entries?.map((entry) => {
          const Icon = entry.type === "dir" ? Folder : kindOf(entry.name) === "text" ? FileText : File;
          return (
            <li key={entry.path} className="group flex items-center gap-2 px-2">
              <button
                type="button"
                onClick={() => (entry.type === "dir" ? setPath(entry.path) : setPreview(entry))}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-muted"
              >
                <Icon
                  className={cx("size-4 shrink-0", entry.type === "dir" ? "text-foreground" : "text-muted-foreground")}
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {entry.type === "dir" ? ago(entry.modifiedAt) : sizeLabel(entry.size)}
                </span>
              </button>
              {entry.type === "file" ? (
                <a
                  href={fileUrl(entry.path, true)}
                  aria-label={`Download ${entry.name}`}
                  className="grid size-7 place-items-center rounded-lg opacity-0 group-hover:opacity-100 hover:bg-muted"
                >
                  <Download className="size-3.5" />
                </a>
              ) : null}
              <button
                type="button"
                aria-label={`Delete ${entry.name}`}
                className="grid size-7 place-items-center rounded-lg opacity-0 group-hover:opacity-100 hover:bg-muted"
                onClick={() =>
                  window.confirm(`Delete ${entry.name}?`) &&
                  void api("DELETE", `/files?path=${encodeURIComponent(entry.path)}`)
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
