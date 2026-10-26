import type { Hono } from "hono";
import { platforms } from "../../shared/roster.ts";
import type { Accounts } from "../accounts.ts";
import type { Store, StoredState } from "../store.ts";
import type { Voice } from "../voice.ts";
import { speechContext, VoiceError } from "../voice.ts";
import { HttpError } from "./util.ts";

/** The largest recording taken; five minutes of a browser's speech recording is well under it. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

/** The names a space's speech should be spelled with: its bots and what they work on. */
export function spaceSpeechContext(state: StoredState) {
  const topics =
    state.kind === "jobs"
      ? [state.candidate.name, state.candidate.location.split(",")[0] ?? "", "LinkedIn", "Naukri", "Indeed"]
      : [state.profile.brand, ...state.profile.platforms.map((id) => platforms[id].name), "Gemini"];
  return speechContext(
    Object.values(state.bots).map((bot) => bot.name),
    [...topics, ...state.groups.map((group) => group.name)],
  );
}

/** Voice typing: the speech model's status and download, and turning a recording into text. */
export function voiceRoutes(
  app: Hono,
  { voice, store, accounts, ownerId }: { voice: Voice; store: Store; accounts: Accounts; ownerId: string },
) {
  app.get("/api/voice", async (c) => c.json(await voice.status()));

  /** Starts the one-time download, so it runs while the person is still talking. */
  app.post("/api/voice/prepare", async (c) => {
    voice.prepare().catch(() => {});
    return c.json(await voice.status());
  });

  /** A recording, sent as it is; the words come back to be typed into the message box. */
  app.post("/api/voice/transcribe", async (c) => {
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (!audio.length) throw new HttpError(400, "The recording was empty.");
    try {
      const text = await voice.transcribe(audio, {
        language: accounts.get(ownerId).preferences.dictation,
        prompt: spaceSpeechContext(store.state),
        signal: c.req.raw.signal,
      });
      return c.json({ text });
    } catch (error) {
      if (error instanceof VoiceError) throw new HttpError(error.status, error.message);
      throw error;
    }
  });
}
