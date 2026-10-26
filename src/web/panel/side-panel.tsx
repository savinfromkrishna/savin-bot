import { X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useState } from "react";
import type { Bot } from "../../shared/contracts.ts";
import { Button, Tabs } from "../ui.tsx";
import { BotSettings } from "./bot-settings.tsx";
import { ComputerPanel } from "./computer-panel.tsx";

type Mode = "settings" | "computer";

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

/** Whether the right panel is open, what it shows and how wide it is; remembered per browser. */
export function usePanel() {
  // On a phone the panel covers the whole thread, so it only opens when asked.
  const [open, setOpen] = useState(() => read("panel:open", "false") === "true" && window.innerWidth >= 768);
  const [mode, setMode] = useState<Mode>(() =>
    read("panel:mode", "settings") === "computer" ? "computer" : "settings",
  );
  const [width, setWidth] = useState(() => Number(read("panel:width", "384")) || 384);
  return {
    open,
    mode,
    width,
    toggle(next: Mode) {
      const opening = !(open && mode === next);
      setOpen(opening);
      setMode(next);
      write("panel:open", String(opening));
      write("panel:mode", next);
    },
    show(next: Mode) {
      setMode(next);
      write("panel:mode", next);
    },
    close() {
      setOpen(false);
      write("panel:open", "false");
    },
    resize(next: number) {
      const clamped = Math.min(1000, Math.max(320, Math.round(next)));
      setWidth(clamped);
      write("panel:width", String(clamped));
    },
  };
}

export type Panel = ReturnType<typeof usePanel>;

export function SidePanel({ bot, panel }: { bot: Bot; panel: Panel }) {
  const startResize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.width;
    const move = (moveEvent: PointerEvent) => panel.resize(startWidth + (startX - moveEvent.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    // A phone shows it full screen; a tablet or small laptop lays it over the thread; a wide screen puts it beside.
    <aside
      className="fixed inset-0 z-30 flex flex-col bg-card md:absolute md:inset-y-0 md:right-0 md:left-auto md:z-20 md:max-w-[calc(100%-3rem)] md:border-l md:border-border md:shadow-2xl xl:relative xl:max-w-none xl:shadow-none"
      style={{ width: window.innerWidth >= 768 ? panel.width : undefined }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable resize handle, not a rule */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={startResize}
        className="absolute top-0 bottom-0 -left-1 hidden w-2 cursor-col-resize md:block"
      />
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <Tabs
          value={panel.mode}
          onChange={panel.show}
          options={[
            { value: "settings", label: "Settings" },
            ...(bot.computerAccess !== "off" ? [{ value: "computer" as const, label: "Computer" }] : []),
          ]}
        />
        <Button variant="ghost" size="icon" onClick={panel.close} aria-label="Close panel">
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel.mode === "computer" && bot.computerAccess !== "off" ? (
          <ComputerPanel bot={bot} />
        ) : (
          <BotSettings key={bot.id} bot={bot} />
        )}
      </div>
    </aside>
  );
}
