import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  AudioLines,
  Bot,
  Braces,
  Brain,
  Briefcase,
  Camera,
  ChartLine,
  Clapperboard,
  Coffee,
  Compass,
  Crown,
  Film,
  FolderOpen,
  Gamepad2,
  Globe,
  Hash,
  Heart,
  Image,
  Megaphone,
  MessagesSquare,
  Mic,
  Monitor,
  Music2,
  Palette,
  PenLine,
  Plug,
  Rocket,
  Scissors,
  Search,
  Send,
  Sparkles,
  SquarePlay,
  SquareTerminal,
  Star,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import type { PlatformId, Run, RunStatus, ToolGroup } from "../../shared/contracts.ts";

/** Icons a bot avatar can use (the Avatar Studio offers these). */
export const avatarIcons: Record<string, LucideIcon> = {
  bot: Bot,
  crown: Crown,
  compass: Compass,
  "pen-line": PenLine,
  clapperboard: Clapperboard,
  send: Send,
  "messages-square": MessagesSquare,
  sparkles: Sparkles,
  rocket: Rocket,
  megaphone: Megaphone,
  camera: Camera,
  film: Film,
  "music-2": Music2,
  heart: Heart,
  star: Star,
  zap: Zap,
  brain: Brain,
  palette: Palette,
  scissors: Scissors,
  mic: Mic,
  search: Search,
  "chart-line": ChartLine,
  globe: Globe,
  coffee: Coffee,
};

export const avatarColors = [
  "#7c3aed",
  "#0284c7",
  "#db2777",
  "#0d9488",
  "#4f46e5",
  "#c026d3",
  "#18181b",
  "#475569",
  "#0891b2",
  "#9333ea",
];

export const toolGroupMeta: Record<ToolGroup, { label: string; icon: LucideIcon }> = {
  screen: { label: "Screen", icon: Monitor },
  browser: { label: "Browser", icon: Globe },
  files: { label: "Files", icon: FolderOpen },
  shell: { label: "Shell", icon: SquareTerminal },
  video: { label: "Video", icon: Clapperboard },
};

/** Icons for apps in the integrations catalog (keyed by the catalog's icon name). */
export const appIcons: Record<string, LucideIcon> = {
  "square-play": SquarePlay,
  camera: Camera,
  users: Users,
  "at-sign": AtSign,
  briefcase: Briefcase,
  send: Send,
  "gamepad-2": Gamepad2,
  hash: Hash,
  webhook: Webhook,
  image: Image,
  "audio-lines": AudioLines,
  braces: Braces,
  mcp: Plug,
};

export const platformIcon: Record<PlatformId, LucideIcon> = {
  youtube: SquarePlay,
  instagram: Camera,
  tiktok: Music2,
  x: AtSign,
  linkedin: Briefcase,
  facebook: Users,
};

export const statusMeta: Record<RunStatus, { label: string; tone: string }> = {
  running: { label: "Working", tone: "text-muted-foreground" },
  waiting: { label: "Needs you", tone: "text-warning" },
  succeeded: { label: "Done", tone: "text-success" },
  failed: { label: "Failed", tone: "text-destructive" },
  cancelled: { label: "Stopped", tone: "text-muted-foreground" },
};

export const isLive = (run: Run) => run.status === "running" || run.status === "waiting";

const toolNames: Record<string, string> = {
  terminal_run: "Ran a command",
  files_list: "Listed files",
  files_read: "Read a file",
  files_write: "Wrote a file",
  browser_open: "Opened a page",
  browser_snapshot: "Read the page",
  browser_click: "Clicked",
  browser_type: "Typed",
  browser_press: "Pressed a key",
  browser_scroll: "Scrolled",
  browser_upload: "Uploaded files",
  browser_screenshot: "Looked at the page",
  browser_login: "Signed in",
  request_takeover: "Asked for help",
  computer_screenshot: "Looked at the screen",
  computer_click: "Clicked",
  computer_type: "Typed",
  computer_key: "Pressed keys",
  computer_scroll: "Scrolled",
  web_fetch: "Read a page",
  http_request: "Called an API",
  memory_save: "Updated memory",
  candidate_update: "Updated your profile",
  habit_list: "Read your habits",
  habit_set: "Set a habit",
  habit_check: "Marked a habit",
  track_application: "Updated the tracker",
  list_applications: "Read the tracker",
  open_work: "Updated open work",
  skill_read: "Read a skill",
  delegate: "Delegated",
  gemini_video: "Made a scene with Gemini",
  video_join: "Joined clips",
  youtube_studio_upload: "Uploaded to YouTube",
};

/** An attached file as the chat shows it: a long paste is "Pasted text", anything else its file name. */
export function attachmentName(path: string) {
  const name = path.split("/").pop() ?? path;
  return name.startsWith("pasted-") ? "Pasted text" : name;
}

/** "browser_click" → "Clicked"; "telegram_send_message" → "Telegram send message". */
export function toolLabel(name: string) {
  const known = toolNames[name];
  if (known) return known;
  const plain = name.replace(/^mcp__[a-z0-9-]+__/i, "").replace(/[_-]+/g, " ");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

export function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function duration(startIso: string, endIso: string | null | undefined) {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

const actionPhrases: Record<string, string> = {
  terminal_run: "running this command",
  files_write: "writing this file",
  browser_click: "clicking on the page",
  browser_type: "typing on the page",
  browser_press: "pressing a key on the page",
  browser_upload: "uploading files",
  browser_login: "signing in",
  computer_click: "clicking on the desktop",
  computer_type: "typing on the desktop",
  computer_key: "pressing keys on the desktop",
  computer_scroll: "scrolling the desktop",
  http_request: "calling this API",
  gemini_video: "making this scene with Gemini",
  video_join: "joining these clips",
  youtube_studio_upload: "uploading to YouTube",
};

/** The approval card's headline: "Review before running this command", or the tool for apps. */
export const approvalTitle = (name: string) => {
  const phrase = actionPhrases[name];
  return phrase ? `Review before ${phrase}` : `Review: ${toolLabel(name)}`;
};
