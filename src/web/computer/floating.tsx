import { X } from "lucide-react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useState } from "react";

/** A draggable window over the computer screen, as savin shows Terminal and Files. */
export function FloatingWindow({
  title,
  initial,
  onClose,
  children,
}: {
  title: string;
  initial: "left" | "right";
  onClose: () => void;
  children: ReactNode;
}) {
  const width = Math.min(560, window.innerWidth - 24);
  const height = Math.min(420, window.innerHeight - 180);
  const [position, setPosition] = useState(() => ({
    x: initial === "left" ? 16 : Math.max(16, window.innerWidth - width - 16),
    y: 72,
  }));

  const drag = (event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const start = { x: event.clientX - position.x, y: event.clientY - position.y };
    const move = (moveEvent: PointerEvent) =>
      setPosition({
        x: Math.min(window.innerWidth - 80, Math.max(-width + 80, moveEvent.clientX - start.x)),
        y: Math.min(window.innerHeight - 40, Math.max(0, moveEvent.clientY - start.y)),
      });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section
      aria-label={title}
      className="absolute z-10 flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      style={{ left: position.x, top: position.y, width, height }}
    >
      <header
        onPointerDown={drag}
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 active:cursor-grabbing"
      >
        <span className="flex-1 text-[13px] font-semibold select-none">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="grid size-7 place-items-center rounded-lg hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
