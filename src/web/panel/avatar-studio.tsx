import type { ClipboardEvent, DragEvent } from "react";
import { useState } from "react";
import type { Avatar } from "../../shared/contracts.ts";
import { avatarColors, avatarIcons } from "../lib/meta.ts";
import { Button, cx, Segmented, Tabs } from "../ui.tsx";

/** Shrinks a picture to a small square data URL so avatars stay light. */
async function toAvatarImage(file: File) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 160;
  const context = canvas.getContext("2d");
  const side = Math.min(bitmap.width, bitmap.height);
  context?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 160, 160);
  return canvas.toDataURL("image/jpeg", 0.86);
}

export function AvatarStudio({
  avatar,
  onChange,
  onClose,
}: {
  avatar: Avatar;
  onChange: (avatar: Avatar) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"bot" | "upload">(avatar.image ? "upload" : "bot");
  const set = (change: Partial<Avatar>) => onChange({ ...avatar, ...change });
  const accept = async (file: File | undefined) => {
    if (file?.type.startsWith("image/")) set({ image: await toAvatarImage(file) });
  };

  return (
    <div className="absolute top-full left-1/2 z-20 mt-2 w-72 -translate-x-1/2 space-y-3 rounded-2xl border border-border bg-card p-3 shadow-xl">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "bot", label: "Bot" },
          { value: "upload", label: "Upload" },
        ]}
      />
      {tab === "bot" ? (
        <div className="grid grid-cols-8 gap-1">
          {Object.entries(avatarIcons).map(([name, Icon]) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              onClick={() => set({ icon: name, image: null })}
              className={cx(
                "grid size-8 place-items-center rounded-lg hover:bg-muted",
                avatar.icon === name && !avatar.image && "bg-muted ring-1 ring-foreground/30",
              )}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: drop and paste target for a picture
        <div
          onDragOver={(event: DragEvent) => event.preventDefault()}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            void accept(event.dataTransfer.files[0]);
          }}
          onPaste={(event: ClipboardEvent) => void accept(event.clipboardData.files[0])}
          className="grid h-24 place-items-center rounded-xl border border-dashed border-input text-center text-xs text-muted-foreground"
        >
          <label className="cursor-pointer px-3">
            Drag, drop, or paste an image
            <input type="file" accept="image/*" hidden onChange={(event) => void accept(event.target.files?.[0])} />
          </label>
        </div>
      )}
      <Segmented
        label="Shape"
        value={avatar.shape}
        onChange={(shape) => set({ shape })}
        options={[
          { value: "circle", label: "Circle" },
          { value: "square", label: "Square" },
        ]}
      />
      <div className="flex flex-wrap gap-1.5">
        {avatarColors.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Colour ${color}`}
            onClick={() => set({ color })}
            className={cx(
              "size-6 rounded-full",
              avatar.color === color && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
            )}
            style={{ background: color }}
          />
        ))}
      </div>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => set({ image: null })}>
          Reset
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
