import { createReadStream, createWriteStream, watch } from "node:fs";
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntry } from "../../shared/contracts.ts";

const types: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
};

export const contentType = (path: string) => types[extname(path).toLowerCase()] ?? "application/octet-stream";

export class FileError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

/** The shared workspace as a file system the UI can browse; nothing outside it is reachable. */
export class Workspace {
  constructor(readonly root: string) {}

  /** Resolves a workspace-relative path and refuses anything outside, including through links. */
  async resolve(path: string, { mustExist = true } = {}) {
    const full = resolve(this.root, path.replace(/^[/\\]+/, ""));
    const inside = (candidate: string, root: string) => {
      const rel = relative(root, candidate);
      return !rel.startsWith("..") && !isAbsolute(rel);
    };
    if (!inside(full, this.root)) throw new FileError(400, `${path} is outside the workspace`);
    const realRoot = await realpath(this.root);
    let existing = full;
    // For new files, check the nearest existing parent instead.
    while (true) {
      try {
        const real = await realpath(existing);
        if (!inside(real, realRoot)) throw new FileError(400, `${path} is outside the workspace`);
        break;
      } catch (error) {
        if (error instanceof FileError) throw error;
        if (mustExist && existing === full) throw new FileError(404, `${path} does not exist`);
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    return full;
  }

  relative(full: string) {
    return relative(this.root, full).replaceAll("\\", "/");
  }

  async list(path = ""): Promise<FileEntry[]> {
    const dir = await this.resolve(path);
    const entries = await readdir(dir, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        const info = await stat(full).catch(() => null);
        if (!info) return null;
        return {
          name: entry.name,
          path: this.relative(full),
          type: info.isDirectory() ? "dir" : "file",
          size: info.isDirectory() ? 0 : info.size,
          modifiedAt: info.mtime.toISOString(),
        } satisfies FileEntry;
      }),
    );
    return listed
      .filter((entry): entry is FileEntry => entry !== null)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  /** Opens a file for reading; a Range header ("bytes=start-end") lets videos seek. */
  async read(path: string, range?: string) {
    const full = await this.resolve(path);
    const info = await stat(full);
    if (info.isDirectory()) throw new FileError(400, `${path} is a folder`);
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    let start = 0;
    let end = Math.max(0, info.size - 1);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    }
    const partial = Boolean(match) && start <= end;
    return {
      stream: createReadStream(full, partial ? { start, end } : {}),
      size: info.size,
      start,
      end,
      partial,
      type: contentType(full),
      name: basename(full),
    };
  }

  async writeText(path: string, content: string) {
    const full = await this.resolve(path, { mustExist: false });
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  /** Streams an upload straight to disk, so large videos never sit in memory. */
  async upload(path: string, body: ReadableStream<Uint8Array>, maxBytes = 4 * 1024 ** 3) {
    const full = await this.resolve(path, { mustExist: false });
    await mkdir(dirname(full), { recursive: true });
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > maxBytes ? new FileError(413, "File is too large") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(body as never), limit, createWriteStream(full));
    return this.relative(full);
  }

  async mkdir(path: string) {
    await mkdir(await this.resolve(path, { mustExist: false }), { recursive: true });
  }

  async move(from: string, to: string) {
    const source = await this.resolve(from);
    const target = await this.resolve(to, { mustExist: false });
    if (await stat(target).catch(() => null)) throw new FileError(409, `${to} already exists`);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }

  async remove(path: string) {
    const full = await this.resolve(path);
    if (full === resolve(this.root)) throw new FileError(400, "The workspace itself cannot be deleted");
    await rm(full, { recursive: true, force: true });
  }

  /** Calls back (debounced) whenever anything in the workspace changes. */
  watch(onChange: () => void) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const watcher = watch(this.root, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 300);
      });
      return () => watcher.close();
    } catch {
      return () => {};
    }
  }
}
