import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleHooks } from "./claude.ts";

type Hook = (input: { hook_event_name: string; tool_input?: unknown }) => Promise<Record<string, any>>;

const hookOf = (rules?: { ask: string[]; deny: string[] }): Hook | undefined => (ruleHooks(rules) as any).hooks?.PreToolUse?.[0]?.hooks?.[0];

test("no rules, no hook", () => {
  assert.deepEqual(ruleHooks(undefined), {});
  assert.deepEqual(ruleHooks({ ask: [], deny: [] }), {});
});

test("the hook only watches Bash", () => {
  assert.equal((ruleHooks({ ask: ["x"], deny: [] }) as any).hooks.PreToolUse[0].matcher, "Bash");
});

test("a denied command is refused and an asked one waits", async () => {
  const hook = hookOf({ ask: ["wrangler deploy"], deny: ["rm -rf"] })!;
  const denied = await hook({ hook_event_name: "PreToolUse", tool_input: { command: "rm -rf build" } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
  const asked = await hook({ hook_event_name: "PreToolUse", tool_input: { command: "wrangler deploy" } });
  assert.equal(asked.hookSpecificOutput.permissionDecision, "ask");
  assert.ok(asked.hookSpecificOutput.permissionDecisionReason.length > 0);
});

test("anything else is left to the permission mode", async () => {
  const hook = hookOf({ ask: ["wrangler deploy"], deny: ["rm -rf"] })!;
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } }), {});
  assert.deepEqual(await hook({ hook_event_name: "PostToolUse", tool_input: { command: "rm -rf x" } }), {});
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_input: {} }), {});
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_input: { command: 42 } }), {});
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse" }), {});
});
