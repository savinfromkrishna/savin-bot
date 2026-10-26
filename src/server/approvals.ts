import type { ApprovalRule, ComputerAccess } from "../shared/contracts.ts";
import type { Tool } from "./tools/tool.ts";

export type Gate = { gate: false } | { gate: true; allowAlways: boolean };

/** Groups covered by a bot's Computer access setting. */
const computerGroups = new Set(["screen", "browser", "files", "shell", "video", "web"]);

const specificity = (rule: ApprovalRule, tool: Tool) => {
  const { target } = rule;
  if (target.kind === "tool") return target.tool === tool.name ? 3 : 0;
  if (target.kind === "connector") return target.connectorId === tool.connectorId ? 2 : 0;
  return target.category === tool.category ? 1 : 0;
};

/** The most specific matching rule; at equal specificity, asking beats allowing. */
export function matchRule(rules: ApprovalRule[], tool: Tool) {
  let best: ApprovalRule | null = null;
  let bestScore = 0;
  for (const rule of rules) {
    const score = specificity(rule, tool);
    if (score === 0) continue;
    if (score > bestScore || (score === bestScore && rule.action === "require_approval")) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Whether an action waits for a person. Reads never wait. Under "Ask first" every computer
 * action asks (allow or deny only). Otherwise account rules decide, and integration
 * actions that change something ask until someone chooses "Always allow".
 */
export function approvalFor(tool: Tool, access: ComputerAccess, rules: ApprovalRule[]): Gate {
  if (tool.readOnly || tool.group === "team" || tool.group === "knowledge") return { gate: false };
  if (computerGroups.has(tool.group) && access === "ask") return { gate: true, allowAlways: false };
  const rule = matchRule(rules, tool);
  if (rule) return rule.action === "require_approval" ? { gate: true, allowAlways: true } : { gate: false };
  if (tool.connectorId) return { gate: true, allowAlways: true };
  return { gate: false };
}

/** A few readable lines describing what the action will do, for the approval card. */
export function describeInput(input: Record<string, unknown>) {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
    })
    .join("\n");
}
