const HOOK_EVENTS = new Set([
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
]);
const SESSION_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isBoundedSubagent(input) {
  return nonEmptyString(input?.agent_id) !== null || nonEmptyString(input?.agent_type) !== null;
}

export function resolveHookIdentity(input, { event = input?.hook_event_name } = {}) {
  const contextId = nonEmptyString(input?.session_id);
  const hookEvent = HOOK_EVENTS.has(event) ? event : "unknown";
  const source = SESSION_SOURCES.has(input?.source) ? input.source : "none";
  const boundedSubagent = isBoundedSubagent(input);
  const status = contextId ? "accepted" : "missing_session_id";
  return {
    contextId,
    status,
    boundedSubagent,
    audit: Object.freeze({
      schemaVersion: 1,
      hookEvent,
      source,
      sessionId: contextId ? "present" : "missing",
      turnId: nonEmptyString(input?.turn_id) ? "present" : "absent",
      boundedSubagent,
      identityStatus: status,
    }),
  };
}
