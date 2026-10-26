import { useSearchParams } from "react-router-dom";

/** Dialogs and the computer live in the URL, so Back closes them and links can open them. */
export function useOverlay() {
  const [params, setParams] = useSearchParams();
  const set = (changes: Record<string, string | null>) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  return {
    settings: params.get("settings"),
    integrations: params.get("integrations"),
    computer: params.get("computer"),
    /** The tab the computer opens on, such as a browser's own tab for signing in. */
    tab: params.get("tab"),
    window: params.get("window"),
    routine: params.get("routine"),
    /** "bot", "space" or "group": savin's create panels. */
    create: params.get("create"),
    set,
  };
}
