import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendKeysCombo, sendKeysText, xdotoolCombo } from "../src/server/tools/computer.ts";
import type { Shell } from "../src/server/tools/terminal.ts";
import { runCommand, shell, shellInvocation } from "../src/server/tools/terminal.ts";
import { workspacePath } from "../src/server/tools/tool.ts";

const cwd = mkdtempSync(join(tmpdir(), "savin-social-shell-"));
const signal = () => new AbortController().signal;
const node = (code: string) => `node -e "${code}"`;
const powershell: Shell = { name: "Windows PowerShell", file: "powershell.exe", kind: "powershell" };

describe("terminal", () => {
  it("returns output and exit code", async () => {
    const result = await runCommand(node("console.log('hello'); process.exit(3)"), {
      cwd,
      timeoutMs: 20_000,
      signal: signal(),
    });
    expect(result).toMatchObject({ exitCode: 3, output: "hello", timedOut: false });
  });

  it("kills commands that run too long", async () => {
    const result = await runCommand(node("setTimeout(() => {}, 60000)"), { cwd, timeoutMs: 1500, signal: signal() });
    expect(result.timedOut).toBe(true);
  });

  it("keeps the start and end of very long output", async () => {
    const result = await runCommand(node("for (let i = 0; i < 5000; i++) console.log('line ' + i)"), {
      cwd,
      timeoutMs: 20_000,
      signal: signal(),
      maxChars: 400,
    });
    expect(result.output).toMatch(/^line 0/);
    expect(result.output).toMatch(/line 4999$/);
    expect(result.output).toMatch(/characters omitted/);
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    const pending = runCommand(node("setTimeout(() => {}, 60000)"), {
      cwd,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("Cancelled")), 300);
    await expect(pending).rejects.toThrow("Cancelled");
  });

  it("does not pass the model key to commands", async () => {
    process.env.LLM_API_KEY = "secret-value";
    const result = await runCommand(node("console.log(process.env.LLM_API_KEY ?? 'none')"), {
      cwd,
      timeoutMs: 20_000,
      signal: signal(),
    });
    delete process.env.LLM_API_KEY;
    expect(result.output).toBe("none");
  });

  it("hands PowerShell the command untouched, outside the script text", () => {
    const { file, args, env } = shellInvocation(`Write-Output "it's ok"`, powershell);
    expect(file).toBe("powershell.exe");
    expect(env).toEqual({ RS_COMMAND: `Write-Output "it's ok"` });
    expect(Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le")).not.toContain(`Write-Output "it's`);
    expect(shellInvocation("ls", { name: "bash", file: "/bin/bash", kind: "posix" })).toEqual({
      file: "/bin/bash",
      args: ["-c", "ls"],
      env: {},
    });
  });

  it.runIf(shell.kind === "posix")("keeps quoting intact through the shell", async () => {
    const result = await runCommand(`echo "it's \\"quoted\\""`, { cwd, timeoutMs: 20_000, signal: signal() });
    expect(result.output).toBe(`it's "quoted"`);
  });

  it.runIf(process.platform === "win32")(
    "reports PowerShell errors as text with real exit codes",
    async () => {
      const run = (command: string) =>
        runCommand(command, { cwd, timeoutMs: 60_000, signal: signal(), shell: powershell });
      expect(await run("Get-Item nope-does-not-exist")).toMatchObject({
        exitCode: 1,
        output: expect.stringMatching(/^Cannot find path/),
      });
      expect(await run(`node -e "console.error('warn'); process.exit(0)" 2>&1`)).toMatchObject({
        exitCode: 0,
        output: "warn",
      });
      expect(await run(`node -e "process.exit(7)"`)).toMatchObject({ exitCode: 7 });
      expect(await run("Write-Output (")).toMatchObject({ exitCode: 1, output: expect.not.stringContaining("CLIXML") });
      expect(await run("Write-Output 'héllo ✓'")).toMatchObject({ exitCode: 0, output: "héllo ✓" });
    },
    300_000,
  );
});

describe("workspace paths", () => {
  it("refuses paths outside the workspace", () => {
    expect(workspacePath(cwd, "posts/a.mp4")).toBe(join(cwd, "posts", "a.mp4"));
    expect(() => workspacePath(cwd, "../secrets.txt")).toThrow(/outside the workspace/);
    expect(() => workspacePath(cwd, join(tmpdir(), "elsewhere.txt"))).toThrow(/outside the workspace/);
  });
});

describe("computer key mapping", () => {
  it("escapes SendKeys control characters in typed text", () => {
    expect(sendKeysText("50% off (today) {deal} +1 ~ ^")).toBe("50{%} off {(}today{)} {{}deal{}} {+}1 {~} {^}");
    expect(sendKeysText("a\nb\tc")).toBe("a{ENTER}b{TAB}c");
  });

  it("maps shortcuts for Windows and X11", () => {
    expect(sendKeysCombo("ctrl+shift+s")).toBe("^+s");
    expect(sendKeysCombo("Enter")).toBe("{ENTER}");
    expect(sendKeysCombo("alt+f4")).toBe("%{F4}");
    expect(() => sendKeysCombo("win+r")).toThrow(/Unsupported modifier/);
    expect(xdotoolCombo("ctrl+alt+Delete")).toBe("ctrl+alt+Delete");
    expect(xdotoolCombo("enter")).toBe("Return");
    expect(xdotoolCombo("win+pagedown")).toBe("super+Next");
  });
});
