import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillView } from "../shared/contracts.ts";

export const builtInSkillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));
/** A job search space's built-in skills: coaching, profiles, habits and interviews. */
export const jobSkillsDir = fileURLToPath(new URL("../../job-skills/", import.meta.url));

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Reads `name` and `description` from a SKILL.md front matter block. */
export function parseSkill(content: string) {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, "m")
      .exec(front)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  return { name: field("name") ?? "", description: field("description") ?? "" };
}

export const skillTemplate = `---
name: new-skill
description: One sentence on when to use this skill.
---

# Steps

1.
`;

/** Shared skills: SKILL.md recipes every bot can read. Built-in ones ship with the app. */
export class SkillLibrary {
  constructor(
    private readonly userDir: string,
    private readonly builtInDir = builtInSkillsDir,
  ) {}

  private async scan(dir: string, builtIn: boolean) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const skills: (SkillView & { content: string })[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const content = await readFile(join(dir, entry.name, "SKILL.md"), "utf8").catch(() => null);
      if (!content) continue;
      const { name, description } = parseSkill(content);
      skills.push({ name: name || entry.name, description, builtIn, content });
    }
    return skills;
  }

  /** Your own skills override built-in ones with the same name. */
  private async all() {
    const own = await this.scan(this.userDir, false);
    const builtIn = (await this.scan(this.builtInDir, true)).filter(
      (skill) => !own.some((mine) => mine.name === skill.name),
    );
    return [...builtIn, ...own].sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(): Promise<SkillView[]> {
    return (await this.all()).map(({ name, description, builtIn }) => ({ name, description, builtIn }));
  }

  async read(name: string) {
    return (await this.all()).find((skill) => skill.name === name) ?? null;
  }

  async save(content: string, previousName?: string) {
    const { name, description } = parseSkill(content);
    if (!name || !description) throw new Error("The SKILL.md front matter needs a name and a description");
    if (previousName && previousName !== name) await this.remove(previousName);
    const dir = join(this.userDir, slug(name));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content);
    return name;
  }

  async remove(name: string) {
    for (const entry of await readdir(this.userDir, { withFileTypes: true }).catch(() => [])) {
      const content = await readFile(join(this.userDir, entry.name, "SKILL.md"), "utf8").catch(() => null);
      if (content && parseSkill(content).name === name) await rm(join(this.userDir, entry.name), { recursive: true });
    }
  }
}
