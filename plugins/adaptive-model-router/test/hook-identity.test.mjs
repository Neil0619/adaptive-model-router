import test from "node:test";
import assert from "node:assert/strict";
import { resolveHookIdentity } from "../scripts/lib/hook-identity.mjs";

test("stable hook identity accepts only a non-empty host session_id", () => {
  const accepted = resolveHookIdentity({
    hook_event_name: "UserPromptSubmit",
    session_id: "  trusted-session  ",
    turn_id: "ephemeral-turn",
  });
  assert.equal(accepted.contextId, "trusted-session");
  assert.equal(accepted.status, "accepted");

  for (const session_id of [undefined, null, "", "   ", 42]) {
    const missing = resolveHookIdentity({
      hook_event_name: "UserPromptSubmit",
      session_id,
      turn_id: "must-not-be-used-as-context",
    });
    assert.equal(missing.contextId, null);
    assert.equal(missing.status, "missing_session_id");
    assert.equal(missing.audit.turnId, "present");
    assert.doesNotMatch(JSON.stringify(missing.audit), /must-not-be-used-as-context/);
  }
});

test("hook identity audit is bounded and never includes raw ids, prompt, or cwd", () => {
  const secret = "secret-identity-value";
  const resolved = resolveHookIdentity({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: secret,
    turn_id: secret,
    prompt: secret,
    cwd: `/tmp/${secret}`,
  });
  assert.deepEqual(resolved.audit, {
    schemaVersion: 1,
    hookEvent: "SessionStart",
    source: "compact",
    sessionId: "present",
    turnId: "present",
    boundedSubagent: false,
    identityStatus: "accepted",
  });
  assert.equal(JSON.stringify(resolved.audit).includes(secret), false);
});
