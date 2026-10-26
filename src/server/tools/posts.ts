import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";
import { Workspace } from "../workspace/files.ts";
import type { Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

/** Instagram's tallest feed post: 4:5 portrait at full resolution. */
const WIDTH = 1080;
const HEIGHT = 1350;

/** Each subject's label, its colour on the dark slide, and a deeper one for diagrams on their light card. */
const subjects = {
  cs: { label: "Computer science", accent: "#60a5fa", deep: "#1d4ed8" },
  mechanical: { label: "Mechanical", accent: "#fb923c", deep: "#c2410c" },
  electrical: { label: "Electrical", accent: "#facc15", deep: "#a16207" },
  bridge: { label: "CS × Mechanical × Electrical", accent: "#c084fc", deep: "#7e22ce" },
} as const;

const Slide = z.object({
  title: z.string().trim().min(1).max(140),
  body: z.string().trim().max(700).optional(),
  points: z.array(z.string().trim().min(1).max(180)).max(6).optional(),
  formula: z.string().trim().max(200).optional().describe("One equation in plain text or Unicode, such as V = I × R"),
  code: z.string().max(700).optional().describe("A few short lines of code or pseudocode"),
  diagram: z
    .string()
    .trim()
    .max(30_000)
    .regex(/^<svg[\s>][\s\S]*<\/svg>$/, "A diagram is one <svg>…</svg> element")
    .optional()
    .describe(
      'An inline <svg> with a viewBox (about 900 wide), drawn on a light card: lines and text in currentColor, highlights with class="hl" (stroke) or class="hl-fill", text at least 28 units',
    ),
  note: z.string().trim().max(220).optional().describe("A small line at the bottom: a unit, an assumption or a source"),
});
type Slide = z.infer<typeof Slide>;
type Subject = keyof typeof subjects;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
/** Escaped text where **this** stands out in the subject's colour and line breaks are kept. */
const inline = (text: string) =>
  escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");

// Nothing on the page runs or loads: the slides are only text, shapes and the diagrams' SVG.
const page = (body: string, subject: Subject) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --accent: ${subjects[subject].accent}; --deep: ${subjects[subject].deep}; }
body { background: #0b1020; font-family: "Segoe UI", "Nirmala UI", "Noto Sans", system-ui, sans-serif; }
.slide { width: ${WIDTH}px; height: ${HEIGHT}px; padding: 72px 80px 64px; display: flex; flex-direction: column; gap: 40px;
  overflow: hidden; color: #f1f5f9;
  background: radial-gradient(circle at 88% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 55%), #0b1020; }
header, footer { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
header { font-size: 26px; color: #94a3b8; letter-spacing: 0.08em; text-transform: uppercase; }
.tag { color: var(--accent); border: 2px solid var(--accent); border-radius: 999px; padding: 8px 22px; }
main { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 32px; }
h1 { font-size: 64px; line-height: 1.12; font-weight: 800; letter-spacing: -0.01em; }
.cover h1 { font-size: 92px; line-height: 1.05; }
.body { font-size: 38px; line-height: 1.4; color: #e2e8f0; }
.cover .body { font-size: 42px; color: #cbd5e1; }
ul { list-style: none; display: flex; flex-direction: column; gap: 20px; }
li { position: relative; padding-left: 44px; font-size: 36px; line-height: 1.35; color: #e2e8f0; }
li::before { content: ""; position: absolute; left: 0; top: 0.45em; width: 18px; height: 18px; border-radius: 4px; background: var(--accent); }
strong { color: var(--accent); font-weight: 700; }
.formula { font-family: "Cambria Math", Cambria, "STIX Two Math", serif; font-size: 52px; padding: 28px 36px;
  border-left: 8px solid var(--accent); border-radius: 0 16px 16px 0; background: rgba(255, 255, 255, 0.06); }
.code { font-family: "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace; font-size: 30px; line-height: 1.45; padding: 28px 32px;
  white-space: pre-wrap; color: #e2e8f0; background: #020617; border: 2px solid #1e293b; border-radius: 16px; }
.diagram { flex: 1 1 0; min-height: 280px; display: flex; padding: 28px; color: #0f172a; background: #f8fafc; border-radius: 24px; }
.diagram svg { width: 100%; height: 100%; font-family: inherit; }
.diagram .hl { stroke: var(--deep); }
.diagram .hl-fill { fill: var(--deep); }
.note { font-size: 24px; line-height: 1.35; color: #94a3b8; }
footer { font-size: 28px; color: #cbd5e1; }
.swipe { color: var(--accent); }
.sheet { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; width: ${WIDTH}px; padding: 12px; }
.sheet img { width: 100%; display: block; }
</style></head><body>${body}</body></html>`;

const slideHtml = (slide: Slide, index: number, total: number, subject: Subject, handle: string) => {
  const cover = index === 0;
  return `<section class="slide${cover ? " cover" : ""}">
<header><span class="tag">${escapeHtml(subjects[subject].label)}</span><span>${index + 1} / ${total}</span></header>
<main>
<h1>${inline(slide.title)}</h1>
${slide.body ? `<p class="body">${inline(slide.body)}</p>` : ""}
${slide.formula ? `<div class="formula">${escapeHtml(slide.formula)}</div>` : ""}
${slide.code ? `<pre class="code">${escapeHtml(slide.code)}</pre>` : ""}
${slide.points?.length ? `<ul>${slide.points.map((point) => `<li>${inline(point)}</li>`).join("")}</ul>` : ""}
${slide.diagram ? `<figure class="diagram">${slide.diagram}</figure>` : ""}
</main>
${slide.note ? `<p class="note">${inline(slide.note)}</p>` : ""}
<footer><span>${escapeHtml(handle)}</span>${cover && total > 1 ? '<span class="swipe">Swipe →</span>' : ""}</footer>
</section>`;
};

/** Draws carousel slides as images, so text, formulas and diagrams come out sharp and exactly as written. */
export function postTools(): Tool[] {
  return [
    defineTool({
      name: "carousel_render",
      group: "files",
      description:
        "Draw an Instagram carousel as 1080×1350 JPEG slides (slide-01.jpg, slide-02.jpg, …) in a workspace folder, from titles, text, bullet points, a formula, code and SVG diagrams. The first slide is the cover. Wrap words in **double asterisks** to highlight them. Returns a preview of every slide and names any slide whose content does not fit.",
      input: z.object({
        folder: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .describe("Workspace folder, such as posts/instagram/2026-10-25-pid-control"),
        subject: z.enum(Object.keys(subjects) as [Subject, ...Subject[]]),
        handle: z.string().trim().min(1).max(40).describe("The name on every slide, such as @yourpage"),
        slides: z.array(Slide).min(1).max(20),
      }),
      async run({ folder, subject, handle, slides }, context) {
        const workspace = new Workspace(context.workspaceDir);
        const dir = await workspace.resolve(folder, { mustExist: false });
        await mkdir(dir, { recursive: true });
        const browser = await chromium.launch({ headless: true });
        try {
          const tab = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
          await tab.route("**/*", (route) => route.abort());
          await tab.setContent(
            page(
              slides.map((slide, index) => slideHtml(slide, index, slides.length, subject, handle)).join(""),
              subject,
            ),
          );
          const overfull: number[] = await tab.$$eval("main", (mains) =>
            mains.flatMap((main, index) =>
              main.scrollHeight > main.clientHeight + 2 || main.scrollWidth > main.clientWidth + 2 ? [index + 1] : [],
            ),
          );
          // A shorter carousel drawn again leaves no slides behind from the longer one.
          for (const name of await readdir(dir)) if (/^slide-\d+\.jpg$/.test(name)) await rm(join(dir, name));
          const shots: Buffer[] = [];
          const sections = await tab.locator("section.slide").all();
          for (const [index, section] of sections.entries()) {
            const shot = await section.screenshot({ type: "jpeg", quality: 92 });
            await writeFile(join(dir, `slide-${String(index + 1).padStart(2, "0")}.jpg`), shot);
            shots.push(shot);
          }
          await tab.setContent(
            page(
              `<div class="sheet">${shots.map((shot) => `<img src="data:image/jpeg;base64,${shot.toString("base64")}">`).join("")}</div>`,
              subject,
            ),
          );
          const preview = await tab.locator(".sheet").screenshot({ type: "jpeg", quality: 70 });
          const where = workspace.relative(dir);
          context.activity("write", `${where}/ (${shots.length} slides)`);
          return {
            text: [
              `Drew ${shots.length} slides in ${where}/: slide-01.jpg to slide-${String(shots.length).padStart(2, "0")}.jpg.`,
              overfull.length
                ? `Slide ${overfull.join(", ")} ${overfull.length === 1 ? "does" : "do"} not fit and ${overfull.length === 1 ? "is" : "are"} cut off: shorten or split ${overfull.length === 1 ? "it" : "them"}, then draw the carousel again.`
                : "Everything fits.",
            ].join("\n"),
            image: `data:image/jpeg;base64,${preview.toString("base64")}`,
          };
        } finally {
          await browser.close();
        }
      },
    }),
  ];
}
