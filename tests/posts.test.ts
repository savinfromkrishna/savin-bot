import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { postTools } from "../src/server/tools/posts.ts";
import type { ToolContext } from "../src/server/tools/tool.ts";

/** Width and height from a JPEG's frame header. */
const jpegSize = (data: Buffer) => {
  for (let at = 2; at < data.length; ) {
    const marker = data[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    at += 2 + data.readUInt16BE(at + 2);
  }
  return null;
};

const installed = existsSync(chromium.executablePath());

describe.skipIf(!installed)("carousel slides", () => {
  const root = mkdtempSync(join(tmpdir(), "savin-social-posts-"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end();
  });
  afterAll(() => server.close());
  const [tool] = postTools();
  const context: ToolContext = {
    runId: "run",
    botId: "writer",
    signal: new AbortController().signal,
    workspaceDir: root,
    credentials: [],
    delegate: async () => "",
    handoff: async () => "",
    requestApproval: async () => true,
    requestTakeover: async () => true,
    waitForControl: async () => {},
    activity: () => {},
  };
  const draw = async (input: Record<string, unknown>) => {
    const parsed = tool?.parse({ subject: "electrical", handle: "@circuits.daily", ...input });
    if (!parsed?.ok) throw new Error(parsed?.error ?? "no tool");
    return tool?.run(parsed.value, context);
  };

  it("draws every slide at Instagram's 4:5 size and returns a preview", async () => {
    const result = await draw({
      folder: "posts/instagram/2026-10-25-rc",
      slides: [
        { title: "Capacitor = code ka **buffer**?", body: "Chalo samajhte hain." },
        { title: "Time constant", formula: "τ = R × C", code: "level += (input - level) * alpha" },
        {
          title: "Charging curve",
          diagram:
            '<svg viewBox="0 0 900 560"><path d="M40 520 C 200 120, 500 60, 860 50" stroke="currentColor" stroke-width="5" fill="none"/></svg>',
          note: "Ideal capacitor, no leakage",
        },
      ],
    });
    expect(result?.text).toContain("Drew 3 slides in posts/instagram/2026-10-25-rc/");
    expect(result?.text).toContain("Everything fits.");
    expect(result?.image).toMatch(/^data:image\/jpeg;base64,/);
    const dir = join(root, "posts/instagram/2026-10-25-rc");
    expect(readdirSync(dir).sort()).toEqual(["slide-01.jpg", "slide-02.jpg", "slide-03.jpg"]);
    expect(jpegSize(readFileSync(join(dir, "slide-02.jpg")))).toEqual({ width: 1080, height: 1350 });

    // Drawn again with fewer slides, the old ones go.
    await draw({ folder: "posts/instagram/2026-10-25-rc", slides: [{ title: "Only the cover" }] });
    expect(readdirSync(dir)).toEqual(["slide-01.jpg"]);
  });

  it("names the slides that do not fit", async () => {
    const long = "Yeh ek bahut lamba point hai jo slide par jagah gherta hai aur aage badhta hi jata hai.";
    const result = await draw({
      folder: "posts/full",
      slides: [{ title: "Cover" }, { title: "Too much", body: long.repeat(7), points: Array(6).fill(long) }],
    });
    expect(result?.text).toContain("Slide 2 does not fit");
  });

  it("loads nothing from outside and stays in the workspace", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await draw({
      folder: "posts/sealed",
      slides: [
        {
          title: "Sealed",
          diagram: `<svg viewBox="0 0 900 560"><image href="http://127.0.0.1:${port}/leak.png" width="100" height="100"/><script>fetch("http://127.0.0.1:${port}/script")</script></svg>`,
        },
      ],
    });
    expect(requests).toEqual([]);
    await expect(draw({ folder: "../outside", slides: [{ title: "x" }] })).rejects.toThrow(/outside the workspace/);
    expect(
      tool?.parse({ folder: "x", subject: "cs", handle: "@a", slides: [{ title: "x", diagram: "<img>" }] }).ok,
    ).toBe(false);
  });
});
