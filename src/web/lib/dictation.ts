import { useEffect, useRef, useState } from "react";
import type { VoiceStatus } from "../../shared/contracts.ts";
import { api, transcribe } from "./api.ts";

export type DictationState =
  | { phase: "idle" }
  | { phase: "listening"; seconds: number; level: number }
  /** `setup` is how much of the one-time speech model download has arrived, while it is still downloading. */
  | { phase: "transcribing"; setup: number | null };

/** Quiet after speech that ends a command; a breath between phrases is well under it. */
const END_SILENCE_MS = 1500;
/** Waveform loudness (RMS, from 0 to 1) above which the microphone hears speech. */
const SPEECH_LEVEL = 0.02;
/** With nothing heard for this long, the recording goes as it is; the speech model decides. */
const NOTHING_HEARD_MS = 15_000;
const MAX_RECORDING_MS = 5 * 60_000;
const TICK_MS = 100;
/** Formats browsers record speech in, best first. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

type Session = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  audio: AudioContext;
  timer?: ReturnType<typeof setInterval>;
  sending: AbortController;
  cancelled: boolean;
};

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The microphone is blocked. Allow it for this site from the browser's address bar.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  if (name === "NotReadableError") return "Another app is using the microphone.";
  return "The microphone didn't start.";
}

const release = (session: Session) => {
  clearInterval(session.timer);
  for (const track of session.stream.getTracks()) track.stop();
  void session.audio.close().catch(() => {});
};

/**
 * Voice typing: records until the person stops talking (or stops it), then the speech model on this
 * computer writes it out and `onText` receives the words.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const deliver = useRef(onText);
  deliver.current = onText;

  const cancel = (message: string | null = null) => {
    const current = session.current;
    session.current = null;
    if (current) {
      current.cancelled = true;
      current.sending.abort();
      release(current);
      if (current.recorder.state !== "inactive") current.recorder.stop();
    }
    setState({ phase: "idle" });
    setError(message);
  };

  const stop = () => {
    const current = session.current;
    if (current?.recorder.state === "recording") current.recorder.stop();
  };

  const send = async (current: Session) => {
    release(current);
    if (current.cancelled) return;
    const recording = new Blob(current.chunks, { type: current.recorder.mimeType || current.chunks[0]?.type || "" });
    setState({ phase: "transcribing", setup: null });
    // The first time, the speech model may still be downloading: show how far along it is.
    const check = () =>
      api<VoiceStatus>("GET", "/voice")
        .then((status) => {
          if (session.current !== current) return;
          setState({ phase: "transcribing", setup: status.state === "downloading" ? status.progress : null });
        })
        .catch(() => {});
    void check();
    const poll = setInterval(check, 1000);
    try {
      const text = (await transcribe(recording, current.sending.signal)).trim();
      if (session.current !== current) return;
      session.current = null;
      setState({ phase: "idle" });
      if (text) deliver.current(text);
      else setError("Didn't catch any words. Try again, a little closer to the microphone.");
    } catch (failure) {
      if (session.current !== current) return;
      session.current = null;
      setState({ phase: "idle" });
      setError((failure as Error).message);
    } finally {
      clearInterval(poll);
    }
  };

  const start = async () => {
    if (session.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice typing needs microphone access, which browsers give this app on localhost.");
      return;
    }
    // Made during the click, so the browser lets it run; it measures how loud the microphone is.
    const audio = new AudioContext();
    // The one-time download starts while the person talks.
    void api("POST", "/voice/prepare").catch(() => {});
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (failure) {
      void audio.close().catch(() => {});
      setError(microphoneError(failure));
      return;
    }
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 64_000 });
    const analyser = audio.createAnalyser();
    analyser.fftSize = 2048;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const current: Session = { stream, recorder, chunks: [], audio, sending: new AbortController(), cancelled: false };
    recorder.ondataavailable = (event) => {
      if (event.data.size) current.chunks.push(event.data);
    };
    recorder.onstop = () => void send(current);
    const startedAt = performance.now();
    let heard = false;
    let quietSince = startedAt;
    current.timer = setInterval(() => {
      if (recorder.state !== "recording") return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.sqrt(sum / samples.length);
      const now = performance.now();
      if (level > SPEECH_LEVEL) {
        heard = true;
        quietSince = now;
      }
      const done = heard ? now - quietSince > END_SILENCE_MS : now - startedAt > NOTHING_HEARD_MS;
      if (done || now - startedAt > MAX_RECORDING_MS) return stop();
      setState({ phase: "listening", seconds: Math.floor((now - startedAt) / 1000), level: Math.min(1, level * 10) });
    }, TICK_MS);
    session.current = current;
    recorder.start(250);
    setState({ phase: "listening", seconds: 0, level: 0 });
  };

  // Escape cancels from anywhere on the page.
  const cancelling = useRef(cancel);
  cancelling.current = cancel;
  const listening = state.phase === "listening";
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelling.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening]);

  // Leaving the conversation lets go of the microphone.
  useEffect(
    () => () => {
      const current = session.current;
      session.current = null;
      if (!current) return;
      current.cancelled = true;
      current.sending.abort();
      release(current);
      if (current.recorder.state !== "inactive") current.recorder.stop();
    },
    [],
  );

  return {
    state,
    error,
    start: () => void start(),
    stop,
    cancel: () => cancel(),
    toggle: () => (state.phase === "listening" ? stop() : state.phase === "idle" ? void start() : undefined),
    dismiss: () => setError(null),
  };
}
