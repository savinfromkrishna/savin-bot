import { Bot as BotIcon } from "lucide-react";
import type { Avatar } from "../../shared/contracts.ts";
import { avatarIcons } from "../lib/meta.ts";
import { cx } from "../ui.tsx";

export function AvatarMark({
  avatar,
  size = 36,
  status,
}: {
  avatar: Avatar;
  size?: number;
  status?: "working" | "waiting" | null;
}) {
  const Icon = avatarIcons[avatar.icon] ?? BotIcon;
  const radius = avatar.shape === "circle" ? "rounded-full" : "rounded-[30%]";
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      {avatar.image ? (
        <img src={avatar.image} alt="" className={cx("size-full object-cover", radius)} />
      ) : (
        <span
          className={cx("grid size-full place-items-center text-white", radius)}
          style={{ background: avatar.color }}
        >
          <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />
        </span>
      )}
      {status ? (
        <span
          className={cx(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-sidebar",
            status === "waiting" ? "bg-warning" : "animate-pulse bg-success",
          )}
        />
      ) : null}
    </span>
  );
}
