import { Loader2 } from "lucide-react";
import type { Verification } from "./api";

const LABEL: Record<Verification, string> = { pass: "PASS", fail: "FAIL", running: "Checking", none: "Unverified" };

/** The state of a session's checks: PASS, FAIL, a running state, or Unverified when none ran. */
export function VerifyBadge({ state }: { state?: Verification }) {
  const s = state ?? "none";
  return (
    <span className={`verify-badge ${s}`} title={s === "running" ? "A check is running" : s === "none" ? "No check has run" : `Checks ${s === "pass" ? "passed" : "failed"}`}>
      {s === "running" && <Loader2 size={10} className="spin" />}{LABEL[s]}
    </span>
  );
}
