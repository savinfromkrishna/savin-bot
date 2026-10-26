import { describe, expect, it } from "vitest";
import { approvalFor, describeInput, matchRule } from "../src/server/approvals.ts";
import type { ApprovalRule } from "../src/shared/contracts.ts";
import { fakeTool } from "./helpers.ts";

const rule = (target: ApprovalRule["target"], action: ApprovalRule["action"]): ApprovalRule => ({
  id: Math.random().toString(36),
  createdAt: "",
  target,
  action,
});

describe("approvals", () => {
  const click = fakeTool("browser_click", "browser");
  const look = fakeTool("browser_snapshot", "browser", { readOnly: true });
  const post = fakeTool("x_post", "X", { connectorId: "x", category: "publish" });
  const stats = fakeTool("youtube_channel_stats", "YouTube", { connectorId: "youtube", readOnly: true });
  const delegate = fakeTool("delegate", "team");

  it("never stops reads, delegation or a bot's own notes", () => {
    expect(approvalFor(look, "ask", [])).toEqual({ gate: false });
    expect(approvalFor(stats, "ask", [])).toEqual({ gate: false });
    expect(approvalFor(delegate, "ask", [])).toEqual({ gate: false });
    expect(approvalFor(fakeTool("memory_save", "knowledge"), "ask", [])).toEqual({ gate: false });
  });

  it("asks before every computer action under Ask first, even with an allow rule", () => {
    expect(approvalFor(click, "ask", [rule({ kind: "tool", tool: "browser_click" }, "always_allow")])).toEqual({
      gate: true,
      allowAlways: false,
    });
    expect(approvalFor(click, "full", [])).toEqual({ gate: false });
  });

  it("asks before integrations change something until a rule allows it", () => {
    expect(approvalFor(post, "full", [])).toEqual({ gate: true, allowAlways: true });
    expect(approvalFor(post, "full", [rule({ kind: "tool", tool: "x_post" }, "always_allow")])).toEqual({
      gate: false,
    });
    expect(approvalFor(post, "full", [rule({ kind: "connector", connectorId: "x" }, "always_allow")])).toEqual({
      gate: false,
    });
  });

  it("lets the most specific rule win, and asking win a tie", () => {
    const rules = [
      rule({ kind: "category", category: "publish" }, "require_approval"),
      rule({ kind: "tool", tool: "x_post" }, "always_allow"),
    ];
    expect(matchRule(rules, post)?.action).toBe("always_allow");
    const tie = [
      rule({ kind: "connector", connectorId: "x" }, "always_allow"),
      rule({ kind: "connector", connectorId: "x" }, "require_approval"),
    ];
    expect(matchRule(tie, post)?.action).toBe("require_approval");
    expect(approvalFor(click, "full", [rule({ kind: "tool", tool: "browser_click" }, "require_approval")])).toEqual({
      gate: true,
      allowAlways: true,
    });
  });

  it("describes what an action will do in a few readable lines", () => {
    expect(describeInput({ text: "Hello", replyTo: undefined, tags: [], privacy: "private" })).toBe(
      "text: Hello\nprivacy: private",
    );
  });
});
