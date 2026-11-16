import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRules } from "./rules.ts";

const rules = { ask: ["wrangler deploy", "db:migrate"], deny: ["rm -rf", "docker compose down"] };

test("a command without a rule passes", () => {
  assert.equal(checkRules("pnpm test", rules), null);
  assert.equal(checkRules("", rules), null);
});

test("a rule matches anywhere in the command", () => {
  assert.equal(checkRules("pnpm exec wrangler deploy --env prod", rules)?.decision, "ask");
  assert.equal(checkRules("cd app && pnpm db:migrate && echo ok", rules)?.decision, "ask");
  assert.equal(checkRules("echo hi; rm -rf build", rules)?.decision, "deny");
});

test("runs of whitespace count as one, in the command and in the rule", () => {
  assert.equal(checkRules("wrangler   deploy", rules)?.decision, "ask");
  assert.equal(checkRules("wrangler\tdeploy", rules)?.decision, "ask");
  assert.equal(checkRules("wrangler\n  deploy", rules)?.decision, "ask");
  assert.equal(checkRules("rm -rf x", { ask: [], deny: ["  rm   -rf "] })?.decision, "deny");
});

test("deny wins over ask", () => {
  const both = { ask: ["deploy"], deny: ["deploy"] };
  assert.equal(checkRules("wrangler deploy", both)?.decision, "deny");
});

test("the reason names the rule that matched", () => {
  assert.match(checkRules("rm -rf /tmp/x", rules)!.reason, /"rm -rf"/);
  assert.match(checkRules("wrangler deploy", rules)!.reason, /"wrangler deploy"/);
});

test("matching is case sensitive and does not span a split word", () => {
  assert.equal(checkRules("WRANGLER DEPLOY", rules), null);
  assert.equal(checkRules("wrangler  dep loy", rules), null);
});

test("empty and blank rules never match", () => {
  assert.equal(checkRules("anything", { ask: ["", "   "], deny: [""] }), null);
});

test("no rules means nothing is stopped", () => {
  assert.equal(checkRules("rm -rf /", { ask: [], deny: [] }), null);
});

test("a command built at run time is not seen", () => {
  // Documented limit: this is a safety net against slips, not a lock.
  assert.equal(checkRules('sh -c "wrangler dep""loy"', rules), null);
  assert.equal(checkRules("CMD='rm -r''f'; $CMD", rules), null);
});
