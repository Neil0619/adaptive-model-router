import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lifecycleBinding, nativeQualificationHost, newTaskQualification } from "../scripts/lib/lifecycle-qualification.mjs";
import { verifyHostOperation } from "../scripts/lib/host-compatibility.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = { platform: "darwin", cliVersion: "0.154.0-alpha.6.2", executableDigest: "a".repeat(64),
  executablePathDigest: "b".repeat(64) };
const hooks = ["preToolUse", "subagentStop"].map((eventName) => ({
  pluginId: "adaptive-model-router@adaptive-model-router", eventName, handlerType: "command",
  command: "node trusted-hook.mjs", matcher: "collaboration.*", timeoutSec: 30, async: false,
  source: "plugin", sourcePath: resolve(root, "hooks/hooks.json"),
  enabled: true, trustStatus: "trusted", currentHash: `sha256:${"a".repeat(64)}`, statusMessage: "Checking",
}));
const binding = (nextHost = host, nextHooks = hooks) => lifecycleBinding(nextHooks, root, root, nextHost, root);

test("host labels, disk rebuilds, platform observations and unavailable diagnostics do not revoke a contract", async () => {
  const original = binding();
  for (const changed of [
    { ...host, cliVersion: "0.154.0" },
    { ...host, cliVersion: "unknown-future-build" },
    { ...host, executableDigest: "c".repeat(64) },
    { ...host, executablePathDigest: "d".repeat(64) },
    { platform: "win32", cliVersion: null },
    null,
  ]) {
    const current = binding(changed);
    assert.equal(current.digest, original.digest);
    assert.equal(current.configurationDigest, original.configurationDigest);
    assert.equal(newTaskQualification(current, "new-contract-route").schema, 2);
  }
  const observation = await nativeQualificationHost();
  assert.equal(observation.cliVersion, null);
  assert.equal(observation.source, "hook-process-platform");
});

test("Hook presentation, inventory order and unrelated plugins do not change executable dependencies", () => {
  const changed = hooks.map((hook) => ({ ...hook, statusMessage: "Localized status", currentHash: `sha256:${"c".repeat(64)}` })).reverse();
  changed.push({ pluginId: "unrelated-plugin", command: "another tool", enabled: false });
  assert.equal(binding(host, changed).digest, binding().digest);
});

test("execution definitions, real trust and source remain part of qualification", () => {
  for (const mutation of [
    { command: "node changed-hook.mjs" }, { matcher: "unrelated" }, { async: true },
    { timeoutSec: 1 }, { sourcePath: "/untrusted/hooks.json" }, { enabled: false },
    { trustStatus: "modified" }, { handlerType: "prompt" },
  ]) {
    const changed = structuredClone(hooks);
    Object.assign(changed[0], mutation);
    assert.notEqual(binding(host, changed).digest, binding().digest);
  }
  const changed = binding(); changed.hookSet[0].command = "node unverified.mjs";
  assert.equal(newTaskQualification(changed, "forged-binding"), null);
});

test("the operation verifier rejects caller assertions and mismatched operation references", () => {
  assert.throws(() => verifyHostOperation({ passed: true }, { passed: true }), /contract or identity/);
  assert.throws(() => verifyHostOperation({ contract: "native-child-no-work/1", childId: "foreign", parentId: "root" },
    { child: { id: "actual" }, parentId: "root" }), /contract or identity/);
});
