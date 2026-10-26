import { useEffect, useRef, useState } from "react";
import type { SignInBegin, SignInStatus, Thinking } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";

const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * savin's subscription sign-in: start it, open the provider's page in a new tab, then wait here
 * while the person enters the device code (or pastes back the code from a sign-in link).
 */
export function useSignIn(onConnected: () => void) {
  const [begin, setBegin] = useState<SignInBegin | null>(null);
  const [pending, setPending] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  const loginId = useRef<string | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  const forget = () => {
    if (loginId.current) void api("DELETE", `/models/sign-in/${loginId.current}`).catch(() => {});
    loginId.current = null;
  };

  const cancel = () => {
    attempt.current++;
    forget();
    setBegin(null);
    setPending(false);
    setPopupBlocked(false);
  };

  const start = async (input: { provider: string; model?: string; thinking?: Thinking | null }) => {
    const mine = ++attempt.current;
    forget();
    setError(null);
    setPending(true);
    setPopupBlocked(false);
    try {
      const started = await api<SignInBegin>("POST", "/models/sign-in", input);
      loginId.current = started.loginId;
      if (mine !== attempt.current) return forget();
      setBegin(started);
      const tab = window.open(started.verificationUri, "_blank");
      if (tab) tab.opener = null;
      else setPopupBlocked(true);
      while (mine === attempt.current) {
        await sleep(POLL_MS);
        if (mine !== attempt.current) return;
        const status = await api<SignInStatus>("GET", `/models/sign-in/${started.loginId}`);
        if (status.status === "error") throw new Error(status.error);
        if (status.status === "connected") {
          loginId.current = null;
          setBegin(null);
          setPending(false);
          connected.current();
          return;
        }
      }
    } catch (failure) {
      if (mine !== attempt.current) return;
      forget();
      setError((failure as Error).message || "Could not start sign-in");
      setBegin(null);
      setPending(false);
    }
  };

  /** The pasted callback URL or code, for sign-ins that end on a link. */
  const submit = async (code: string) => {
    if (!begin) return;
    setError(null);
    try {
      await api("POST", `/models/sign-in/${begin.loginId}/code`, { code: code.trim() });
    } catch (failure) {
      setError((failure as Error).message || "Could not finish sign-in");
    }
  };

  // Leaving the page stops the sign-in, as in savin.
  useEffect(
    () => () => {
      attempt.current++;
      if (loginId.current) void api("DELETE", `/models/sign-in/${loginId.current}`).catch(() => {});
    },
    [],
  );

  return { begin, pending, popupBlocked, error, start, submit, cancel };
}
