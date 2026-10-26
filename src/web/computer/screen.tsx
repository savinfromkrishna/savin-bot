import type { KeyboardEvent, MouseEvent, Ref, WheelEvent } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { socketUrl as spaceSocket } from "../lib/api.ts";
import { cx, Spinner } from "../ui.tsx";

export type ScreenMeta = { url: string; title: string };
export type ScreenHandle = { send(message: Record<string, unknown>): void };

const namedKeys = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Insert",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

const socketUrl = (key: string) => spaceSocket(`/browser/${encodeURIComponent(key)}/ws`);

/**
 * A live browser tab drawn from its screencast. With `interactive`, clicks, scrolling and keys
 * go to the page; otherwise it is a view-only preview.
 */
export function BrowserScreen({
  tabKey,
  interactive,
  onMeta,
  handle,
  className,
}: {
  tabKey: string;
  interactive: boolean;
  onMeta?: (meta: ScreenMeta) => void;
  handle?: Ref<ScreenHandle>;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const lastMove = useRef(0);
  const meta = useRef(onMeta);
  meta.current = onMeta;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReady(false);
    setError(null);
    const ws = new WebSocket(socketUrl(tabKey));
    ws.binaryType = "blob";
    ws.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as { t: string; url?: string; title?: string; message?: string };
        if (message.t === "meta") meta.current?.({ url: message.url ?? "", title: message.title ?? "" });
        if (message.t === "error") setError(message.message ?? "Something went wrong");
        return;
      }
      const bitmap = await createImageBitmap(event.data as Blob);
      const element = canvas.current;
      if (element) {
        if (element.width !== bitmap.width || element.height !== bitmap.height) {
          element.width = bitmap.width;
          element.height = bitmap.height;
        }
        element.getContext("2d")?.drawImage(bitmap, 0, 0);
        setReady(true);
      }
      bitmap.close();
    };
    ws.onclose = (event) => {
      if (event.code === 4404) setError("This tab is closed");
    };
    socket.current = ws;
    return () => ws.close();
  }, [tabKey]);

  const send = (message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };
  useImperativeHandle(handle, () => ({ send }), []);

  /** Maps a pointer position to 0–1 page coordinates, allowing for letterboxing. */
  const point = (event: MouseEvent | WheelEvent) => {
    const element = canvas.current;
    if (!element?.width) return null;
    const rect = element.getBoundingClientRect();
    const scale = Math.min(rect.width / element.width, rect.height / element.height);
    const offsetX = (rect.width - element.width * scale) / 2;
    const offsetY = (rect.height - element.height * scale) / 2;
    const x = (event.clientX - rect.left - offsetX) / (element.width * scale);
    const y = (event.clientY - rect.top - offsetY) / (element.height * scale);
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };

  const onKey = (event: KeyboardEvent) => {
    if (!interactive) return;
    const modifiers = [
      event.ctrlKey && "Control",
      event.altKey && "Alt",
      event.metaKey && "Meta",
      event.shiftKey && event.key.length > 1 && "Shift",
    ].filter(Boolean);
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
      send({ t: "text", text: event.key });
    else if (namedKeys.has(event.key) || (event.key.length === 1 && modifiers.length)) {
      send({ t: "key", key: [...modifiers, event.key.length === 1 ? event.key.toLowerCase() : event.key].join("+") });
    } else return;
    event.preventDefault();
  };

  return (
    <div className={cx("relative grid place-items-center overflow-hidden bg-black/90", className)}>
      <canvas
        ref={canvas}
        tabIndex={interactive ? 0 : -1}
        aria-label="Browser screen"
        className={cx(
          "h-full w-full object-contain outline-none",
          interactive ? "cursor-default" : "pointer-events-none",
        )}
        onClick={(event) => {
          const at = point(event);
          if (at && interactive) send({ t: "click", ...at, count: Math.min(event.detail || 1, 3) });
          canvas.current?.focus();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          const at = point(event);
          if (at && interactive) send({ t: "click", ...at, button: "right" });
        }}
        onMouseMove={(event) => {
          if (!interactive || Date.now() - lastMove.current < 120) return;
          lastMove.current = Date.now();
          const at = point(event);
          if (at) send({ t: "move", ...at });
        }}
        onWheel={(event) => interactive && send({ t: "wheel", dx: event.deltaX, dy: event.deltaY })}
        onKeyDown={onKey}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (interactive && text) send({ t: "text", text });
        }}
      />
      {!ready && !error ? (
        <div className="absolute inset-0 grid place-items-center text-white/60">
          <Spinner className="size-5" />
        </div>
      ) : null}
      {error ? <div className="absolute inset-0 grid place-items-center text-sm text-white/70">{error}</div> : null}
    </div>
  );
}
