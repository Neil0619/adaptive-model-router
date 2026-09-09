import { canonicalJson } from "./io.mjs";

const legacyMatchers = new Set([
  "^(?:Agent|spawn_agent|collaborationspawn_agent)$",
  "^(?:Agent|(?:collaboration)?spawn_agent)$",
  "^(?:Agent|(?:collaboration)?(?:spawn_agent|send_message|followup_task))$",
  "^(?:Agent|(?:collaboration)?(?:spawn_agent|send_message|followup_task|list_agents|interrupt_agent))$",
]);
const currentPost = "^(?:Bash|Agent|(?:collaboration)?(?:spawn_agent|send_message|followup_task|list_agents|interrupt_agent))$";

/** Retained shells are provenance for a new no-tool qualification, not proof
 * that a resident child loaded the new guard. Current inventory trust and the
 * subsequent real Hook round trip still decide admission. */
export function supportsResidencyHookMatcherUpgrade(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || previous.length !== current.length) return false;
  const before = structuredClone(previous), after = structuredClone(current);
  for (const eventName of ["preToolUse", "postToolUse"]) {
    const old = before.filter((entry) => entry.eventName === eventName);
    const next = after.filter((entry) => entry.eventName === eventName);
    if (old.length !== 1 || next.length !== 1) return false;
    const expected = eventName === "preToolUse" ? ".*" : currentPost;
    if (next[0].matcher !== expected || (old[0].matcher !== expected && !legacyMatchers.has(old[0].matcher))) return false;
    delete old[0].matcher; delete next[0].matcher;
  }
  return canonicalJson(before) === canonicalJson(after);
}

/** An explicit reviewed residency update may refresh these additive host
 * definitions. Runtime protocols, transport, existing approvals and command
 * handlers remain constrained. This does not confer native Hook trust. */
export function supportsResidencySurfaceRefresh(previous, next) {
  for (const file of [".codex-plugin/plugin.json", "skills/adaptive-model-router/agents/openai.yaml"]) {
    if (previous[file] !== next[file]) return false;
  }
  try {
    const beforeMcp = JSON.parse(previous[".mcp.json"]);
    const afterMcp = JSON.parse(next[".mcp.json"]);
    const before = beforeMcp.mcpServers?.["adaptive-model-router"]?.tools;
    const after = afterMcp.mcpServers?.["adaptive-model-router"]?.tools;
    if (!before || !after) return false;
    if (Object.keys(before).some((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))) return false;
    if (Object.keys(after).some((key) => !Object.hasOwn(before, key) && key !== "manage_stage")) return false;
    if (after.manage_stage?.approval_mode !== "approve" || Object.keys(after.manage_stage).length !== 1) return false;
    delete beforeMcp.mcpServers["adaptive-model-router"].tools;
    delete afterMcp.mcpServers["adaptive-model-router"].tools;
    if (canonicalJson(beforeMcp) !== canonicalJson(afterMcp)) return false;
    const beforeHooks = JSON.parse(previous["hooks/hooks.json"]);
    const afterHooks = JSON.parse(next["hooks/hooks.json"]);
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const old = beforeHooks.hooks?.[event];
      const current = afterHooks.hooks?.[event];
      if (old?.length !== 1 || current?.length !== 1) return false;
      const expected = event === "PreToolUse" ? ".*" : currentPost;
      if (current[0].matcher !== expected || (!legacyMatchers.has(old[0].matcher) && old[0].matcher !== expected)) return false;
      delete old[0].matcher; delete current[0].matcher;
    }
    return canonicalJson(beforeHooks) === canonicalJson(afterHooks);
  } catch { return false; }
}
