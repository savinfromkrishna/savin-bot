import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ffmpegPath from "ffmpeg-static";
import type { VoiceStatus } from "../shared/contracts.ts";

/** A file voice typing downloads, pinned to its exact bytes. */
export type Pinned = { url: string; sha256: string; size: number };

/** What voice typing runs on: whisper.cpp's own build for this machine, the speech model and the speech detector. */
export type VoiceAssets = {
  engine: Pinned & { unpack: "zip" | "tar.gz"; cli: string };
  speech: Pinned & { file: string };
  vad: Pinned & { file: string };
};

const WHISPER_CPP = "b5130"; // whisper.cpp v1.9.4
const release = (file: string) => `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP}/${file}`;
const huggingFace = (repo: string, commit: string, file: string) =>
  `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

const engines: Record<string, VoiceAssets["engine"]> = {
  "win32-x64": {
    url: release("whisper-bin-x64.zip"),
    sha256: "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c",
    size: 8_573_270,
    unpack: "zip",
    cli: "Release/whisper-cli.exe",
  },
  "linux-x64": {
    url: release("whisper-bin-ubuntu-x64.tar.gz"),
    sha256: "53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32",
    size: 9_793_438,
    unpack: "tar.gz",
    cli: "whisper-bin-ubuntu-x64/whisper-cli",
  },
};

/**
 * Whisper small, multilingual and 8-bit. On a four-core laptop it writes a spoken command in two to three
 * seconds and, given the space's names as context, spells them right; larger models took ten times as long.
 * Silero voice detection skips silence, where Whisper would otherwise make up sentences.
 */
const models = {
  speech: {
    file: "ggml-small-q8_0.bin",
    url: huggingFace("ggerganov/whisper.cpp", "5359861c739e955e79d9a303bcbc70fb988958b1", "ggml-small-q8_0.bin"),
    sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
    size: 264_464_607,
  },
  vad: {
    file: "ggml-silero-v6.2.0.bin",
    url: huggingFace("ggml-org/whisper-vad", "9ffd54a1e1ee413ddf265af9913beaf518d1639b", "ggml-silero-v6.2.0.bin"),
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    size: 885_098,
  },
};

/** This machine's assets, or null where whisper.cpp publishes no build. */
export const defaultAssets = (): VoiceAssets | null => {
  const engine = engines[`${process.platform}-${process.arch}`];
  return engine ? { engine, ...models } : null;
};

/** The longest recording transcribed, and the shortest worth trying. */
const MAX_SECONDS = 300;
const MIN_SECONDS = 0.3;
/** How long a download may go without receiving anything. */
const STALL_MS = 60_000;

/** The containers browsers record into, told apart by their first bytes, so ffmpeg is told which and never guesses. */
export function audioFormat(bytes: Uint8Array) {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { extension: "webm", demuxer: "matroska" };
  }
  if (text(0, 4) === "OggS") return { extension: "ogg", demuxer: "ogg" };
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return { extension: "wav", demuxer: "wav" };
  if (text(4, 8) === "ftyp") return { extension: "m4a", demuxer: "mov" };
  return null;
}

/**
 * The names Whisper should spell, said as a sentence: given a bare list, it capitalizes every word it writes.
 * Whisper reads this as the words spoken just before, so it only steers spelling.
 */
export function speechContext(names: string[], topics: string[]) {
  const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, 12);
  const list = (items: string[]) =>
    items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const people = unique(names).map((name) => `the ${name}`);
  const things = unique(topics);
  if (!people.length && !things.length) return "";
  return `Okay, so I asked ${people.length ? list(people) : "the team"}${things.length ? ` about ${list(things)}` : ""}.`;
}

/** whisper-cli's arguments for one recording `seconds` long. */
export function whisperArgs(input: {
  model: string;
  vad: string;
  wav: string;
  out: string;
  language: string;
  prompt: string;
  seconds: number;
  threads: number;
}) {
  // Whisper reads 30 seconds at a time; a window the size of the recording is several times faster. It has to
  // cover all of it, with room for the padding voice detection adds, or the end of what was said is lost.
  const window = Math.min(1500, Math.max(256, Math.ceil(input.seconds * 55) + 64));
  return [
    ...["-m", input.model, "-f", input.wav, "-l", input.language],
    ...["-t", String(input.threads), "-ac", String(window)],
    ...["--vad", "-vm", input.vad],
    ...["-sns", "-nt", "-np", "-otxt", "-of", input.out],
    ...(input.prompt ? ["--prompt", input.prompt] : []),
  ];
}

/** The text, without the markers Whisper writes for silence or noise. */
export const cleanTranscript = (text: string) =>
  text
    .replace(/\[[^\]]*\]|\((?:silence|music|noise|inaudible|applause|laughter)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export type Run = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
) => Promise<void>;

/** Runs a program to the end, without a shell; its last line of errors becomes the failure. */
const runProgram: Run = (command, args, { cwd, env, signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.on("data", (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    });
    const stop = () => child.kill();
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(signal.reason ?? new Error("Stopped."));
      else if (code === 0) resolve();
      else reject(new Error(log.trim().split("\n").at(-1)?.trim() || `${basename(command)} stopped (${code}).`));
    });
  });

/** A request voice typing turns down, with the status to answer it with. */
export class VoiceError extends Error {
  constructor(
    readonly status: 415 | 503,
    message: string,
  ) {
    super(message);
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Windows briefly locks a file that was just written while antivirus scans it, so moving or reading one retries. */
export async function patiently<T>(work: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** Deletes, retrying through the same locks; leftovers in a temporary folder are not worth failing over. */
const remove = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * Voice typing on this computer: a recording becomes text with Whisper, run by whisper.cpp. What it needs
 * downloads once into `dir`, each file checked against its pinned checksum; recordings never leave the machine.
 */
export class Voice {
  private readonly assets: VoiceAssets | null;
  private readonly fetch: typeof fetch;
  private readonly run: Run;
  private readonly threads: number;
  private preparing: Promise<void> | null = null;
  private progress = { received: 0, total: 0 };
  private failure: string | null = null;
  private ready = false;
  /** One transcription at a time: each already uses every core. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    options: { assets?: VoiceAssets | null; fetch?: typeof fetch; run?: Run; threads?: number } = {},
  ) {
    this.assets = options.assets === undefined ? defaultAssets() : options.assets;
    this.fetch = options.fetch ?? fetch;
    this.run = options.run ?? runProgram;
    this.threads = options.threads ?? Math.min(8, availableParallelism());
  }

  private paths(assets: VoiceAssets) {
    const engine = join(this.dir, `whisper.cpp-${assets.engine.sha256.slice(0, 12)}`);
    return {
      engine,
      cli: join(engine, assets.engine.cli),
      speech: join(this.dir, assets.speech.file),
      vad: join(this.dir, assets.vad.file),
    };
  }

  /** What is still to download. A file only ever lands in place after its checksum matched. */
  private async missing(assets: VoiceAssets) {
    const { engine, cli, speech, vad } = this.paths(assets);
    const size = (path: string) =>
      stat(path).then(
        (file) => file.size,
        () => -1,
      );
    return [
      ...((await size(cli)) > 0 ? [] : [{ pinned: assets.engine, path: `${engine}.${assets.engine.unpack}` }]),
      ...((await size(speech)) === assets.speech.size ? [] : [{ pinned: assets.speech, path: speech }]),
      ...((await size(vad)) === assets.vad.size ? [] : [{ pinned: assets.vad, path: vad }]),
    ];
  }

  async status(): Promise<VoiceStatus> {
    if (!this.assets) return { state: "unsupported", progress: 0, error: null };
    if (this.preparing) {
      const { received, total } = this.progress;
      return { state: "downloading", progress: total ? Math.min(1, received / total) : 0, error: null };
    }
    if (!this.ready && !(await this.missing(this.assets)).length) this.ready = true;
    if (this.ready) return { state: "ready", progress: 1, error: null };
    return { state: this.failure ? "failed" : "missing", progress: 0, error: this.failure };
  }

  /** Downloads whatever is missing, once, however many ask at the same time. */
  prepare(): Promise<void> {
    const assets = this.assets;
    if (!assets) return Promise.reject(new VoiceError(503, "Voice typing isn't available on this system yet."));
    if (this.ready) return Promise.resolve();
    this.preparing ??= this.install(assets).then(
      () => {
        this.ready = true;
        this.failure = null;
        this.preparing = null;
      },
      (error: unknown) => {
        this.failure = `The speech model did not download: ${messageOf(error)}`;
        this.preparing = null;
        throw new VoiceError(503, this.failure);
      },
    );
    return this.preparing;
  }

  private async install(assets: VoiceAssets) {
    await mkdir(this.dir, { recursive: true });
    const missing = await this.missing(assets);
    this.progress = { received: 0, total: missing.reduce((sum, item) => sum + item.pinned.size, 0) };
    for (const { pinned, path } of missing) {
      await this.download(pinned, path);
      if (pinned === assets.engine) {
        await this.unpack(assets.engine, path, this.paths(assets).engine);
        await remove(path).catch(() => {});
      }
    }
  }

  /** Streams a file to disk, then keeps it only if every byte matches its checksum. */
  private async download(pinned: Pinned, path: string) {
    // A connection that stops sending for a minute is given up on, so the download never hangs.
    const stalled = new AbortController();
    let idle = setTimeout(() => stalled.abort(new Error("the download stalled")), STALL_MS);
    const partial = `${path}.download`;
    const hash = createHash("sha256");
    let received = 0;
    try {
      const response = await this.fetch(pinned.url, { redirect: "follow", signal: stalled.signal });
      if (!response.ok || !response.body) {
        throw new Error(`${new URL(pinned.url).hostname} answered ${response.status}`);
      }
      const check = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          clearTimeout(idle);
          idle = setTimeout(() => stalled.abort(new Error("the download stalled")), STALL_MS);
          received += chunk.length;
          if (received > pinned.size) return done(new Error("the file is bigger than expected"));
          hash.update(chunk);
          this.progress.received += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        check,
        createWriteStream(partial),
        {
          signal: stalled.signal,
        },
      );
      if (received !== pinned.size || hash.digest("hex") !== pinned.sha256) {
        throw new Error("the file did not match its checksum, so it was not used");
      }
      await patiently(() => rename(partial, path));
    } catch (error) {
      await remove(partial).catch(() => {});
      throw stalled.signal.aborted ? stalled.signal.reason : error;
    } finally {
      clearTimeout(idle);
    }
  }

  private async unpack(engine: VoiceAssets["engine"], archive: string, into: string) {
    const staging = `${into}.unpacking`;
    await remove(staging);
    await mkdir(staging, { recursive: true });
    // Windows' own tar reads zip files too, and it refuses entries that would land outside the folder.
    const tar =
      process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    await this.run(tar, [engine.unpack === "zip" ? "-xf" : "-xzf", archive, "-C", staging], { timeoutMs: 120_000 });
    await stat(join(staging, engine.cli));
    await remove(into);
    await patiently(() => rename(staging, into));
  }

  /** The words in a recording, in `language` (or whichever it detects, for "auto"). */
  async transcribe(audio: Uint8Array, options: { language: string; prompt: string; signal?: AbortSignal }) {
    const format = audioFormat(audio);
    if (!format) throw new VoiceError(415, "That recording isn't in a format voice typing can read.");
    await this.prepare();
    const assets = this.assets as VoiceAssets;
    const job = this.queue.then(() => this.transcribeNow(assets, audio, format, options));
    this.queue = job.catch(() => {});
    return job;
  }

  private async transcribeNow(
    assets: VoiceAssets,
    audio: Uint8Array,
    format: { extension: string; demuxer: string },
    { language, prompt, signal }: { language: string; prompt: string; signal?: AbortSignal },
  ) {
    signal?.throwIfAborted();
    if (!ffmpegPath) throw new Error("ffmpeg is not available on this machine.");
    const { cli, speech, vad } = this.paths(assets);
    const dir = await mkdtemp(join(tmpdir(), "savin-voice-"));
    try {
      const recording = join(dir, `recording.${format.extension}`);
      const wav = join(dir, "speech.wav");
      const out = join(dir, "speech");
      await writeFile(recording, audio);
      // 16 kHz mono is what Whisper hears, and ffmpeg may read only this one local file.
      await this.run(
        ffmpegPath,
        [
          ...["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file"],
          ...["-f", format.demuxer, "-i", recording, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"],
          ...["-map_metadata", "-1", "-fflags", "+bitexact", "-t", String(MAX_SECONDS), wav],
        ],
        { signal, timeoutMs: 60_000 },
      );
      const seconds = ((await stat(wav)).size - 44) / 32_000;
      if (seconds < MIN_SECONDS) return "";
      await this.run(
        cli,
        whisperArgs({ model: speech, vad, wav, out, language, prompt, seconds, threads: this.threads }),
        {
          cwd: dirname(cli),
          // The Linux build keeps its libraries beside it.
          env: process.platform === "linux" ? { ...process.env, LD_LIBRARY_PATH: dirname(cli) } : undefined,
          signal,
          timeoutMs: 180_000,
        },
      );
      const text = await patiently(() => readFile(`${out}.txt`, "utf8")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return cleanTranscript(text);
    } finally {
      await remove(dir).catch(() => {});
    }
  }
}
