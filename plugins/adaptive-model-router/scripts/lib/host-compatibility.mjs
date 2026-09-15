import { auditNativeContractNoWorkTranscript } from "./native-recovery-audit.mjs";
import { payloadHash } from "./io.mjs";

export const HOST_LIFECYCLE_CONTRACT = "native-child-no-work/1";
export const HOOK_DISPATCH_CONTRACT = "native-router-hook-dispatch/1";
export const HOST_PREDISPATCH_CONTRACT = "native-spawn-profile-rejection/1";
export const HOST_CAPACITY_CONTRACT = "native-spawn-capacity-rejection/1";
export const HOST_MESSAGE_CONTRACT = "native-message-delivery/1";
const PLUGIN_ID = "adaptive-model-router@adaptive-model-router";

// Host labels and presentation do not change execution semantics. The native
// inventory reader still checks the current trust hash and exact plugin source;
// removing them from this projection does not grant or inherit Hook trust.
export function hookDependencyProjection(hooks) {
  return hooks.filter((hook) => hook.pluginId === PLUGIN_ID).map((hook) =>
    Object.fromEntries([
      "eventName", "handlerType", "command", "matcher", "timeoutSec", "async",
      "source", "sourcePath", "pluginId", "enabled", "trustStatus",
    ].map((field) => [field, hook[field] ?? null])))
    .sort((left, right) => payloadHash(left).localeCompare(payloadHash(right)));
}

export function hostObservation(host) {
  return Object.fromEntries(["platform", "arch", "cliVersion", "executableDigest", "executablePathDigest", "source"]
    .map((field) => [field, typeof host?.[field] === "string" ? host[field] : null]));
}

// This is an internal source-owned verifier, not a public "passed" input. Its
// caller supplies the complete raw source and correlated native projection;
// the qualification transaction separately verifies ticket/Hook/outcome facts.
export function verifyHostOperation(reference, evidence) {
  if (reference?.contract !== HOST_LIFECYCLE_CONTRACT
    || reference.childId !== evidence?.child?.id || reference.parentId !== evidence?.parentId) {
    throw new Error("Host operation contract or identity is unproven");
  }
  return auditNativeContractNoWorkTranscript(evidence.bytes, evidence.child, evidence.parentId);
}
