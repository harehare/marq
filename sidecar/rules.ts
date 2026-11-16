// The `ask` and `deny` rules of an environment note, matched against Bash commands.

export type Rules = { ask: string[]; deny: string[] };

export type Verdict = { decision: "ask" | "deny"; reason: string };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Whether a command line is denied or needs the user's approval. A rule matches when the command
 * contains it, so `wrangler deploy` also catches `pnpm exec wrangler deploy --env prod` and a
 * command in the middle of `a && b`. Deny wins over ask. This is a safety net against slips: a command
 * built at run time (a variable, `sh -c`, a script that runs it) is not seen.
 */
export function checkRules(command: string, rules: Rules): Verdict | null {
  const c = squash(command);
  const hit = (list: string[]) => list.find((r) => squash(r) && c.includes(squash(r)));
  const denied = hit(rules.deny);
  if (denied) return { decision: "deny", reason: `The project's environment note forbids commands containing "${denied}". Ask the user to run it if it is needed.` };
  const asked = hit(rules.ask);
  if (asked) return { decision: "ask", reason: `The project's environment note asks for approval before commands containing "${asked}".` };
  return null;
}
