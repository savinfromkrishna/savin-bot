import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import type { Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

/** Screenshots are scaled to this width; click coordinates use the scaled image. */
const SHOT_WIDTH = 1280;

export type Screenshot = { image: string; width: number; height: number };

export type ComputerDriver = {
  name: string;
  available: boolean;
  screenshot(): Promise<Screenshot>;
  click(x: number, y: number, button: "left" | "right" | "middle", count: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(x: number, y: number, steps: number): Promise<void>;
};

const exec = (file: string, args: string[]) =>
  new Promise<Buffer>((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.toString().trim() || error.message)) : resolve(stdout),
    );
  });

// ---------- Windows: PowerShell + user32 ----------

const sendKeysNames: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  insert: "{INSERT}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  space: " ",
};
const sendKeysModifiers: Record<string, string> = { ctrl: "^", control: "^", shift: "+", alt: "%" };

/** Literal text for SendKeys: its control characters are wrapped in braces. */
export const sendKeysText = (text: string) =>
  text
    .replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
    .replace(/\r?\n/g, "{ENTER}")
    .replace(/\t/g, "{TAB}");

export function sendKeysCombo(combo: string) {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error("No key given");
  const prefix = parts
    .map((part) => {
      const modifier = sendKeysModifiers[part];
      if (!modifier) throw new Error(`Unsupported modifier "${part}"`);
      return modifier;
    })
    .join("");
  const named =
    sendKeysNames[key] ??
    (/^f([1-9]|1[0-6])$/.test(key) ? `{${key.toUpperCase()}}` : key.length === 1 ? sendKeysText(key) : null);
  if (!named) throw new Error(`Unsupported key "${key}"`);
  return prefix + named;
}

const powershellPrelude = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class RsInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
}
'@
[void][RsInput]::SetProcessDPIAware()
function Get-Screen { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
function Get-Scale { [Math]::Max(1.0, (Get-Screen).Width / ${SHOT_WIDTH}.0) }
function Move-To { $s = Get-Scale; [void][RsInput]::SetCursorPos([int]($p.x * $s), [int]($p.y * $s)); Start-Sleep -Milliseconds 60 }
`;

/** Each action reads its parameters from $p. */
const powershellActions = {
  screenshot: `
$screen = Get-Screen; $scale = Get-Scale
$full = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
[System.Drawing.Graphics]::FromImage($full).CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$w = [int][Math]::Round($screen.Width / $scale); $h = [int][Math]::Round($screen.Height / $scale)
$small = New-Object System.Drawing.Bitmap $full, $w, $h
$stream = New-Object System.IO.MemoryStream
$small.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
Write-Output ("$w $h " + [Convert]::ToBase64String($stream.ToArray()))
$full.Dispose(); $small.Dispose()`,
  click: `
Move-To
$flags = @{ left = @(2, 4); right = @(8, 16); middle = @(32, 64) }[$p.button]
for ($i = 0; $i -lt $p.count; $i++) {
  [RsInput]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero); [RsInput]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
}`,
  keys: "[System.Windows.Forms.SendKeys]::SendWait($p.keys)",
  scroll: "Move-To; [RsInput]::mouse_event(0x0800, 0, 0, [int]$p.delta, [UIntPtr]::Zero)",
};

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const decoded = (text: string) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(text)}')))`;

/**
 * One long-lived PowerShell for all desktop actions: starting PowerShell and compiling the
 * input helpers costs seconds, so it happens once. Actions are queued, one at a time.
 */
export class PowerShellSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: string[] = [];
  private notify = () => {};
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prelude: string,
    private readonly file = "powershell.exe",
  ) {}

  run(script: string, params: Record<string, unknown> = {}): Promise<string> {
    const next = this.queue.then(() => this.execute(script, params));
    this.queue = next.catch(() => {});
    return next;
  }

  close() {
    this.child?.kill();
    this.child = null;
  }

  private start() {
    const child = spawn(
      this.file,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      {
        windowsHide: true,
      },
    );
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? "";
      this.lines.push(...parts);
      this.notify();
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.notify();
    });
    child.stdin.write(`Invoke-Expression ${decoded(this.prelude)}\n`);
    this.child = child;
    return child;
  }

  private async execute(script: string, params: Record<string, unknown>) {
    const fresh = !this.child;
    const child = this.child ?? this.start();
    this.lines = [];
    child.stdin.write(
      `$p = ConvertFrom-Json ${decoded(JSON.stringify(params))}; try { Invoke-Expression ${decoded(script)} } catch { Write-Output ('RS_ERROR ' + $_.Exception.Message) }; Write-Output 'RS_DONE'\n`,
    );
    // The first action also pays for starting PowerShell.
    const deadline = Date.now() + (fresh ? 120_000 : 30_000);
    while (!this.lines.includes("RS_DONE")) {
      if (this.child !== child) throw new Error("The desktop helper stopped");
      if (Date.now() > deadline) {
        this.close();
        throw new Error("The desktop action timed out");
      }
      await new Promise<void>((resolve) => {
        this.notify = resolve;
        setTimeout(resolve, 200);
      });
    }
    const output = this.lines.slice(0, this.lines.indexOf("RS_DONE"));
    this.lines = [];
    const error = output.find((line) => line.startsWith("RS_ERROR "));
    if (error) throw new Error(error.slice("RS_ERROR ".length));
    return output.join("\n");
  }
}

function windowsDriver(): ComputerDriver {
  const session = new PowerShellSession(powershellPrelude);
  process.once("exit", () => session.close());
  const run = (action: keyof typeof powershellActions, params: Record<string, unknown> = {}) =>
    session.run(powershellActions[action], params);
  return {
    name: "Windows desktop",
    available: true,
    async screenshot() {
      const [width, height, data] = (await run("screenshot")).trim().split(" ");
      return { image: `data:image/jpeg;base64,${data}`, width: Number(width), height: Number(height) };
    },
    click: async (x, y, button, count) => void (await run("click", { x, y, button, count })),
    type: async (text) => void (await run("keys", { keys: sendKeysText(text) })),
    key: async (combo) => void (await run("keys", { keys: sendKeysCombo(combo) })),
    scroll: async (x, y, steps) => void (await run("scroll", { x, y, delta: -steps * 120 })),
  };
}

// ---------- Linux: X11 via xdotool and ImageMagick ----------

const xdotoolNames: Record<string, string> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  space: "space",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  win: "super",
  meta: "super",
  super: "super",
  cmd: "super",
};

export const xdotoolCombo = (combo: string) =>
  combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => xdotoolNames[part] ?? (/^f\d{1,2}$/.test(part) ? part.toUpperCase() : part))
    .join("+");

function x11Driver(): ComputerDriver {
  const scale = async () => {
    const [width = 0] = (await exec("xdotool", ["getdisplaygeometry"])).toString().trim().split(" ").map(Number);
    return Math.max(1, width / SHOT_WIDTH);
  };
  const at = async (x: number, y: number) => {
    const s = await scale();
    return [String(Math.round(x * s)), String(Math.round(y * s))];
  };
  return {
    name: "X11 desktop",
    available: true,
    async screenshot() {
      const [width = 0, height = 0] = (await exec("xdotool", ["getdisplaygeometry"]))
        .toString()
        .trim()
        .split(" ")
        .map(Number);
      const s = Math.max(1, width / SHOT_WIDTH);
      const size = { width: Math.round(width / s), height: Math.round(height / s) };
      const jpeg = await exec("import", [
        "-silent",
        "-window",
        "root",
        "-resize",
        `${size.width}x${size.height}!`,
        "jpeg:-",
      ]);
      return { image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, ...size };
    },
    async click(x, y, button, count) {
      const which = { left: "1", middle: "2", right: "3" }[button];
      await exec("xdotool", ["mousemove", "--sync", ...(await at(x, y)), "click", "--repeat", String(count), which]);
    },
    type: async (text) => void (await exec("xdotool", ["type", "--delay", "15", "--", text])),
    key: async (combo) => void (await exec("xdotool", ["key", "--", xdotoolCombo(combo)])),
    async scroll(x, y, steps) {
      const button = steps > 0 ? "5" : "4";
      await exec("xdotool", [
        "mousemove",
        "--sync",
        ...(await at(x, y)),
        "click",
        "--repeat",
        String(Math.abs(steps)),
        button,
      ]);
    },
  };
}

const unavailable = (reason: string): ComputerDriver => {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return { name: "Unavailable", available: false, screenshot: fail, click: fail, type: fail, key: fail, scroll: fail };
};

export function createComputerDriver(): ComputerDriver {
  if (process.platform === "win32") return windowsDriver();
  if (process.platform === "linux" && process.env.DISPLAY) {
    const found = spawnSync("sh", ["-c", "command -v xdotool && command -v import"], { stdio: "ignore" });
    if (found.status === 0) return x11Driver();
    return unavailable("Install xdotool and ImageMagick to control this desktop");
  }
  return unavailable("Desktop control isn't supported on this machine");
}

export function computerTools(driver: ComputerDriver): Tool[] {
  const look = async (note: string) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const shot = await driver.screenshot();
    return { text: `${note} Screen is ${shot.width}×${shot.height}.`, image: shot.image };
  };
  const point = { x: z.number().int().min(0), y: z.number().int().min(0) };
  return [
    defineTool({
      name: "computer_screenshot",
      group: "screen",
      readOnly: true,
      description: `See the whole desktop. Coordinates for the other computer tools use this image's size (${SHOT_WIDTH}px wide at most).`,
      input: z.object({}),
      run: () => look("Desktop."),
    }),
    defineTool({
      name: "computer_click",
      group: "screen",
      description: "Click at a point on the desktop screenshot.",
      input: z.object({
        ...point,
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
      }),
      async run({ x, y, button = "left", double }) {
        await driver.click(x, y, button, double ? 2 : 1);
        return look("Clicked.");
      },
    }),
    defineTool({
      name: "computer_type",
      group: "screen",
      description: "Type text into whatever has keyboard focus.",
      input: z.object({ text: z.string().min(1).max(5000) }),
      async run({ text }) {
        await driver.type(text);
        return look("Typed.");
      },
    }),
    defineTool({
      name: "computer_key",
      group: "screen",
      description: "Press a key or shortcut, such as enter, ctrl+s or alt+tab.",
      input: z.object({ keys: z.string().min(1).max(40) }),
      async run({ keys }) {
        await driver.key(keys);
        return look("Pressed.");
      },
    }),
    defineTool({
      name: "computer_scroll",
      group: "screen",
      description: "Scroll at a point on the desktop.",
      input: z.object({
        ...point,
        direction: z.enum(["up", "down"]),
        amount: z.number().int().min(1).max(20).optional(),
      }),
      async run({ x, y, direction, amount = 5 }) {
        await driver.scroll(x, y, direction === "down" ? amount : -amount);
        return look("Scrolled.");
      },
    }),
  ];
}
