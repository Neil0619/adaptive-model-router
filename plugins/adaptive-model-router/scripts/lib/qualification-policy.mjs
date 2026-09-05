import { canonicalJson, parseJson } from "./io.mjs";
import { readModelPolicy } from "./model-policy-store.mjs";
import { resolveModelTarget } from "./model-policy.mjs";

// Historical proof has its original exact target. New proof is bound to an immutable policy.
export function qualificationTargetMatches(db, qualification, route) {
  if (!route) return false;
  if (!route.decision_json) return route.model === "gpt-5.6-sol" && route.effort === "low";
  try {
    const decision = parseJson(route.decision_json, {});
    const binding = qualification?.modelPolicy;
    if (!binding || binding.digest !== decision.policyDigest) return false;
    const policy = readModelPolicy(db, binding.digest);
    const target = resolveModelTarget({ policy, purpose: "qualification", catalog: [{ model: route.model,
      visibility: "list", supportedReasoningEfforts: [route.effort] }] }).target;
    return canonicalJson(target) === canonicalJson(binding.target)
      && target.model === route.model && target.effort === route.effort;
  } catch { return false; }
}
