import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { describe, expect, it } from "vitest";
import { spaceSpeechContext } from "../src/server/routes/voice.ts";
import { freshState, missingTeam } from "../src/server/store.ts";
import type { Run } from "../src/server/voice.ts";
import {
  audioFormat,
  cleanTranscript,
  patiently,
  speechContext,
  Voice,
  VoiceError,
  whisperArgs,
} from "../src/server/voice.ts";
import { fakeVoice, webmRecording } from "./helpers.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "savin-social-voice-"));
const ascii = (text: string) => new TextEncoder().encode(text);

/** A one-channel 16-bit WAV file with a tone, `seconds` long. */
function toneWav(seconds: number, rate = 44_100) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

describe("voice typing", () => {
  it("knows the formats browsers record in, and nothing else", () => {
    expect(audioFormat(webmRecording)).toEqual({ extension: "webm", demuxer: "matroska" });
    expect(audioFormat(ascii("OggS\0\x02rest"))).toEqual({ extension: "ogg", demuxer: "ogg" });
    expect(audioFormat(toneWav(0.1))).toEqual({ extension: "wav", demuxer: "wav" });
    expect(audioFormat(ascii("\0\0\0\x20ftypM4A rest"))).toEqual({ extension: "m4a", demuxer: "mov" });
    expect(audioFormat(ascii("#EXTM3U\nhttp://example.com/a.ts"))).toBeNull();
    expect(audioFormat(ascii("<html>"))).toBeNull();
    expect(audioFormat(new Uint8Array())).toBeNull();
  });

  it("sizes Whisper's window to the recording, listens only to speech and passes the space's words", () => {
    const base = { model: "m.bin", vad: "v.bin", wav: "s.wav", out: "o", language: "en", prompt: "", threads: 8 };
    const window = (seconds: number) => {
      const args = whisperArgs({ ...base, seconds });
      return Number(args[args.indexOf("-ac") + 1]);
    };
    expect(window(0.5)).toBe(256);
    expect(window(5)).toBe(339);
    expect(window(20)).toBe(1164);
    expect(window(60)).toBe(1500);
    const args = whisperArgs({ ...base, seconds: 5, language: "hi", prompt: "Okay, so I asked the Finder." });
    expect(args).toEqual(expect.arrayContaining(["--vad", "-vm", "v.bin", "-l", "hi", "-t", "8", "-nt", "-otxt"]));
    expect(args.slice(-2)).toEqual(["--prompt", "Okay, so I asked the Finder."]);
    expect(whisperArgs({ ...base, seconds: 5 })).not.toContain("--prompt");
  });

  it("says the space's names as a sentence, since a list makes Whisper capitalize every word", () => {
    expect(speechContext(["Coordinator", "Finder", "Finder"], ["LinkedIn", "Naukri"])).toBe(
      "Okay, so I asked the Coordinator and the Finder about LinkedIn and Naukri.",
    );
    expect(speechContext(["Director"], [])).toBe("Okay, so I asked the Director.");
    expect(speechContext([], [" "])).toBe("");

    const jobs = freshState(true, "jobs");
    jobs.candidate = { ...jobs.candidate, name: "Kanha", location: "Pune, India" };
    expect(spaceSpeechContext(jobs)).toBe(
      "Okay, so I asked the Coordinator, the Finder, the Tailor and the Applier about Kanha, Pune, LinkedIn, Naukri and Indeed.",
    );
    const social = { ...freshState(false), bots: missingTeam({}) };
    expect(spaceSpeechContext(social)).toContain("the Director, the Scout");
    expect(spaceSpeechContext(social)).toContain("about My Channel, YouTube and Gemini.");
  });

  it("drops the markers Whisper writes for silence", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n Find ten jobs.\n [ Silence ] (music) ")).toBe("Find ten jobs.");
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
  });

  it("downloads what it needs once, checking every byte, however many ask at a time", async () => {
    const dir = fresh();
    const { voice, assets, fetched, runs } = fakeVoice(dir);
    expect(await voice.status()).toEqual({ state: "missing", progress: 0, error: null });
    await Promise.all([voice.prepare(), voice.prepare(), voice.prepare()]);
    expect(fetched).toEqual([assets.engine.url, assets.speech.url, assets.vad.url]);
    expect(await voice.status()).toEqual({ state: "ready", progress: 1, error: null });
    const tar = runs.find((run) => basename(run.command).toLowerCase().startsWith("tar"));
    expect(tar?.args.slice(0, 2)).toEqual(["-xf", expect.stringMatching(/\.zip$/)]);
    // The archive goes once it is unpacked; the models stay, under their own names.
    expect((await readdir(dir)).sort()).toEqual([
      "speech.bin",
      "vad.bin",
      `whisper.cpp-${assets.engine.sha256.slice(0, 12)}`,
    ]);

    // A restart finds everything in place and downloads nothing again.
    const again = fakeVoice(dir);
    expect(await again.voice.status()).toMatchObject({ state: "ready" });
    await again.voice.prepare();
    expect(again.fetched).toEqual([]);
  });

  it("keeps nothing that does not match its checksum, and tries again when asked", async () => {
    const dir = fresh();
    const { voice, assets, served } = fakeVoice(dir);
    served.set(assets.speech.url, "speech modeX");
    await expect(voice.prepare()).rejects.toThrow(/did not match its checksum/);
    expect(await voice.status()).toMatchObject({ state: "failed", error: expect.stringContaining("checksum") });
    expect((await readdir(dir)).some((name) => name.startsWith("speech.bin"))).toBe(false);

    served.set(assets.speech.url, "speech model");
    await voice.prepare();
    expect(await voice.status()).toMatchObject({ state: "ready" });
  });

  it("turns down a download bigger than its pinned size", async () => {
    const dir = fresh();
    const { voice, assets, served } = fakeVoice(dir);
    served.set(assets.vad.url, "speech detector, and then some");
    await expect(voice.prepare()).rejects.toThrow(/bigger than expected/);
    expect(existsSync(join(dir, "vad.bin"))).toBe(false);
  });

  it("is unavailable where whisper.cpp publishes no build", async () => {
    const voice = new Voice(fresh(), { assets: null });
    expect(await voice.status()).toEqual({ state: "unsupported", progress: 0, error: null });
    await expect(voice.prepare()).rejects.toBeInstanceOf(VoiceError);
  });

  it("writes out a recording: 16 kHz audio, then Whisper with the space's words, and leaves no files behind", async () => {
    const { voice, runs } = fakeVoice(fresh());
    const text = await voice.transcribe(webmRecording, { language: "en", prompt: "Okay, so I asked the Coordinator." });
    expect(text).toBe("Coordinator, find ten React jobs in Pune.");
    const ffmpeg = runs.find((run) => basename(run.command).toLowerCase().startsWith("ffmpeg"));
    expect(ffmpeg?.args).toEqual(
      expect.arrayContaining(["-protocol_whitelist", "file", "-f", "matroska", "-ac", "1", "-ar", "16000"]),
    );
    const whisper = runs.at(-1);
    expect(whisper?.command).toMatch(/whisper-cli\.exe$/);
    expect(whisper?.args).toEqual(expect.arrayContaining(["-l", "en", "-t", "2", "-ac", "339", "--vad"]));
    expect(whisper?.args.slice(-2)).toEqual(["--prompt", "Okay, so I asked the Coordinator."]);
    const recording = ffmpeg?.args[ffmpeg.args.indexOf("-i") + 1] ?? "";
    expect(existsSync(recording)).toBe(false);
  });

  it("waits out a file antivirus is still scanning, and gives up on other errors at once", async () => {
    const failing = (code: string, times: number) => {
      let calls = 0;
      const work = async () => {
        calls++;
        if (calls <= times) throw Object.assign(new Error(code), { code });
        return "done";
      };
      return { work, calls: () => calls };
    };
    const locked = failing("EPERM", 2);
    expect(await patiently(locked.work)).toBe("done");
    expect(locked.calls()).toBe(3);
    const missing = failing("ENOENT", 1);
    await expect(patiently(missing.work)).rejects.toThrow("ENOENT");
    expect(missing.calls()).toBe(1);
    const stuck = failing("EBUSY", 99);
    await expect(patiently(stuck.work, 3)).rejects.toThrow("EBUSY");
    expect(stuck.calls()).toBe(3);
  });

  it("refuses a recording it cannot read before running anything", async () => {
    const { voice, runs } = fakeVoice(fresh());
    await expect(voice.transcribe(ascii("<html>"), { language: "en", prompt: "" })).rejects.toMatchObject({
      status: 415,
    });
    expect(runs).toEqual([]);
  });

  it("writes out one recording at a time", async () => {
    const { voice, runs } = fakeVoice(fresh());
    await voice.prepare();
    let running = 0;
    let most = 0;
    const original = (voice as unknown as { run: Run }).run;
    (voice as unknown as { run: Run }).run = async (command, args, options) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await original(command, args, options);
      running--;
    };
    await Promise.all([1, 2, 3].map(() => voice.transcribe(webmRecording, { language: "en", prompt: "" })));
    expect(most).toBe(1);
    expect(runs.filter((run) => run.command.endsWith("whisper-cli.exe"))).toHaveLength(3);
  });

  it.skipIf(!ffmpegPath)("converts a real recording to 16 kHz mono with the bundled ffmpeg", async () => {
    const heard: number[] = [];
    const { voice } = fakeVoice(fresh());
    await voice.prepare();
    (voice as unknown as { run: Run }).run = async (command, args) => {
      if (basename(command).toLowerCase().startsWith("ffmpeg")) {
        execFileSync(command, args, { windowsHide: true });
        return;
      }
      const wav = args[args.indexOf("-f") + 1] ?? "";
      heard.push((await stat(wav)).size);
      await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, "A tone.");
    };
    expect(await voice.transcribe(toneWav(1.5), { language: "en", prompt: "" })).toBe("A tone.");
    // One and a half seconds at 16,000 two-byte samples a second, after the 44-byte header.
    expect(heard).toEqual([44 + 48_000]);
  });
});
