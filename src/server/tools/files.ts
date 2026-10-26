import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Workspace } from "../workspace/files.ts";
import type { Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

/** savin's Files group: the shared workspace without needing a shell. */
export function filesTools(): Tool[] {
  return [
    defineTool({
      name: "files_list",
      group: "files",
      readOnly: true,
      description: "List a folder in the shared workspace (folders end with /).",
      input: z.object({ path: z.string().max(1000).default("") }),
      async run({ path }, context) {
        const entries = await new Workspace(context.workspaceDir).list(path);
        if (!entries.length) return { text: "(empty folder)" };
        return {
          text: entries
            .map((entry) => (entry.type === "dir" ? `${entry.path}/` : `${entry.path} (${size(entry.size)})`))
            .join("\n"),
        };
      },
    }),
    defineTool({
      name: "files_read",
      group: "files",
      readOnly: true,
      description: "Read a text file from the shared workspace.",
      input: z.object({ path: z.string().min(1).max(1000) }),
      async run({ path }, context) {
        const full = await new Workspace(context.workspaceDir).resolve(path);
        const info = await stat(full);
        if (info.isDirectory()) return { text: `${path} is a folder; use files_list.` };
        const buffer = await readFile(full);
        if (buffer.subarray(0, 8000).includes(0)) return { text: `${path} is a binary file (${size(info.size)}).` };
        const text = buffer.toString("utf8");
        return {
          text: text.length > 40_000 ? `${text.slice(0, 40_000)}\n… ${text.length - 40_000} more characters` : text,
        };
      },
    }),
    defineTool({
      name: "files_write",
      group: "files",
      description: "Create or overwrite a text file in the shared workspace. Folders are created as needed.",
      input: z.object({ path: z.string().min(1).max(1000), content: z.string().max(2_000_000) }),
      async run({ path, content }, context) {
        const workspace = new Workspace(context.workspaceDir);
        await workspace.writeText(path, content);
        context.activity("write", `${path} (${size(Buffer.byteLength(content))})`);
        return { text: `Wrote ${path}.` };
      },
    }),
  ];
}
