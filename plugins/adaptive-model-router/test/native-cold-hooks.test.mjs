import test from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { verifyCapturedMessageCheckpoint } from "./support/native-checkpoint-capture.mjs";
import { HOOK_EVENTS, PENDING_TRUST, assessColdHookEvidence, correlateColdChild, loadColdHookFixture, nativeClient, reviewedProbeScript, runNativeColdHooks, stopOwnedClient, verifyCapturedColdModelRun, verifyColdHookInventory } from "./support/native-cold-hooks.mjs";

const originalLstat = fs.lstatSync, originalChmod = fs.chmodSync;
const offlineModes = new WeakMap();

function modelOfflineRootMode(t, root) {
  let modes = offlineModes.get(t);
  if (!modes) {
    modes = new Map(); offlineModes.set(t, modes);
    // Windows stat/chmod cannot attest POSIX 0700. Model only the roots this
    // offline test creates; all content, links and other paths use the real fs.
    // Live/captured fixture tests never call this helper or inherit its mocks.
    const statMock = t.mock.method(fs, "lstatSync", (path, ...options) => {
      const stat = originalLstat(path, ...options);
      if (modes.has(path)) stat.mode = (stat.mode & ~0o777) | modes.get(path);
      return stat;
    });
    const chmodMock = t.mock.method(fs, "chmodSync", (path, mode) => {
      originalChmod(path, mode);
      if (modes.has(path)) modes.set(path, mode & 0o777);
    });
    syncBuiltinESMExports();
    t.after(() => {
      statMock.mock.restore(); chmodMock.mock.restore(); syncBuiltinESMExports();
      modes.clear(); offlineModes.delete(t);
    });
  }
  modes.set(root, 0o700);
}

// These files and notifications are offline test data, never native Hook evidence.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "router-cold-hooks-unit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  modelOfflineRootMode(t, root);
  const request = { schema: "native-cold-entry-trust-request/1", root, codexHome: join(root, "codex"), project: join(root, "project"),
    cliPath: process.execPath, node: process.execPath, state: "awaiting_explicit_hook_trust", hooksExecuted: 0, nativeTasksCreated: 0,
    modelCalls: 0, globalConfigTouched: false, manifests: {}, requests: {} };
  for (const path of [request.codexHome, request.project]) mkdirSync(path, { mode: 0o700 });
  for (const [index, label] of ["A", "B"].entries()) {
    const market = join(root, `market-${label}`), plugin = join(market, "plugin"), installedPath = join(request.codexHome, `plugins/cache/probe/${label}`);
    for (const base of [plugin, installedPath]) for (const dir of ["hooks", ".codex-plugin"]) mkdirSync(join(base, dir), { recursive: true, mode: 0o700 });
    mkdirSync(join(market, ".agents/plugins"), { recursive: true, mode: 0o700 });
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(plugin, "hook.mjs"))}`;
    const definitions = { hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event[0].toUpperCase() + event.slice(1), [{ matcher: ".*", hooks: [{ type: "command", command, timeout: 10 }] }]])) };
    for (const base of [plugin, installedPath]) {
      writeFileSync(join(base, "hook.mjs"), reviewedProbeScript(root, label));
      writeFileSync(join(base, "hooks/hooks.json"), JSON.stringify(definitions));
      writeFileSync(join(base, ".codex-plugin/plugin.json"), JSON.stringify({ name: "native-cold-entry-probe", version: `0.0.${index + 1}` }));
    }
    writeFileSync(join(market, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "native-cold-evidence" }));
    request.manifests[label] = { pluginId: "native-cold-entry-probe@native-cold-evidence", installedPath };
    request.requests[label] = HOOK_EVENTS.map((eventName, n) => ({ key: `probe:${eventName}`, eventName, handlerType: "command", command,
      async: false, matcher: ".*", timeoutSec: 10, sourcePath: join(installedPath, "hooks/hooks.json"), source: "plugin",
      pluginId: request.manifests[label].pluginId, enabled: true, isManaged: false, currentHash: `sha256:${String(index + n).repeat(64)}`, trustStatus: "untrusted" }));
  }
  writeFileSync(join(root, "trust-request.json"), JSON.stringify(request));
  return loadColdHookFixture(root);
}

function inventory(f, label = "A") {
  return { data: [{ cwd: f.project, errors: [], warnings: [], hooks: f.requests[label].map((row) => ({ ...row, trustStatus: "trusted" })) }] };
}

function hook(f, label, threadId = "offline-parent", event = "sessionStart") {
  return { method: "hook/completed", params: { threadId, turnId: null, run: { id: `${label}-${event}`, eventName: event, source: "plugin",
    sourcePath: f.requests[label].find((row) => row.eventName === event).sourcePath, status: "completed" } } };
}

function log(f, label, threadId = "offline-parent", event = "sessionStart") {
  return { fixture: label, source: pathToFileURL(join(f.root, `market-${label}/plugin/hook.mjs`)).href,
    input: { session_id: threadId, cwd: f.project, hook_event_name: event[0].toUpperCase() + event.slice(1) } };
}

function evidence(f) {
  return { threadId: "offline-parent", resumedId: "offline-parent", persistedPath: join(f.codexHome, "sessions/probe.jsonl"), coldExitConfirmed: true,
    phases: Object.fromEntries(["A", "B"].map((label) => [label, { completed: { params: { threadId: "offline-parent", turn: { id: `turn-${label}`, status: "completed" } } },
      notifications: [hook(f, label)], logs: [log(f, label)] }])) };
}

const approval = (f, stage = "A") => ({ explicitUserApproval: true, root: f.root, approvalDigest: f.approvalDigest, nativeTrustApplied: stage });

function fakeHost(f, label, options = {}) {
  const calls = [], subscribers = new Set();
  let closed = 0;
  const emit = (message) => { for (const callback of subscribers) callback(message); };
  const client = { start: async () => { calls.push("initialize"); }, subscribe: (callback) => { subscribers.add(callback); return () => subscribers.delete(callback); },
    request: async (method, params) => {
      calls.push(method);
      if (method === "hooks/list") return options.inventory || inventory(f, label);
      if (method === "thread/start" || method === "thread/resume") {
        emit(hook(f, label));
        appendFileSync(f.eventLog, `${JSON.stringify(log(f, label))}\n`);
        return { thread: { id: options.resumedId || "offline-parent" } };
      }
      if (method === "thread/shellCommand") {
        assert.equal(params.command, "echo native-cold-hook-persisted");
        assert.equal(params.timeoutMs, 2_000);
        if (!options.ackOnly) {
          const path = join(f.codexHome, "sessions/probe.jsonl");
          mkdirSync(join(f.codexHome, "sessions"), { recursive: true });
          writeFileSync(path, "offline persistence fixture\n");
          emit({ method: "turn/started", params: { threadId: "offline-parent", turn: { id: `turn-${label}`, status: "inProgress" } } });
          emit({ method: "turn/completed", params: { threadId: "offline-parent", turn: { id: options.wrongTurn ? "unrelated-turn" : `turn-${label}`, status: "completed" } } });
        }
        return {};
      }
      if (method === "thread/read") return { thread: { id: "offline-parent", path: join(f.codexHome, "sessions/probe.jsonl") } };
      throw new Error(`Unexpected native method in offline test: ${method}`);
    } };
  return { calls, get closed() { return closed; }, clientFactory: () => client, closeClient: async () => { closed++; if (options.closeFailure) throw new Error("simulated owned process still running"); } };
}

test("offline fixture validation reads fixed reviewed scripts without executing them", (t) => {
  const f = fixture(t);
  assert.match(f.approvalDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(existsSync(f.eventLog), false);
  assert.equal(existsSync(join(f.codexHome, "config.toml")), false);
});

test("offline native launcher binds the reviewed absolute CLI despite an inherited PATH", async (t) => {
  const f = fixture(t);
  f.cliPath = "/reviewed/native/codex";
  let launch;
  const client = nativeClient(f, 100, (command, args, options) => {
    launch = { command, args, options };
    throw new Error("offline launch intercepted");
  });
  await assert.rejects(client.start(), /offline launch intercepted/);
  assert.equal(launch.command, f.cliPath);
  assert.deepEqual(launch.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(launch.options.cwd, f.project);
  assert.equal(launch.options.env.CODEX_HOME, f.codexHome);
  assert.equal(launch.options.env.CODEX_SQLITE_HOME, f.codexHome);
  assert.equal(launch.options.env.HOME, f.root);
  assert.equal(launch.options.env.CODEX_THREAD_ID, "");
  assert.equal(launch.options.env.ADAPTIVE_ROUTER_INVOCATION_ID, "");
});

test("offline fixture rejects changed script bytes even when native command hash is unchanged", (t) => {
  const f = fixture(t);
  appendFileSync(join(f.root, "market-A/plugin/hook.mjs"), "// changed after review\n");
  assert.throws(() => loadColdHookFixture(f.root), /fixed reviewed probe template/);
});

test("offline fixture rejects changed definitions, shared files and writable root", (t) => {
  const f = fixture(t);
  linkSync(join(f.root, "trust-request.json"), join(f.root, "shared.json"));
  assert.throws(() => loadColdHookFixture(f.root), /Shared hard link/);
  rmSync(join(f.root, "shared.json"));
  chmodSync(f.root, 0o755);
  assert.throws(() => loadColdHookFixture(f.root), /private/);
  chmodSync(f.root, 0o700);
  writeFileSync(join(f.root, "market-A/plugin/hooks/hooks.json"), "{}");
  assert.throws(() => loadColdHookFixture(f.root), /reviewed probe template/);
});

test("native fixture validation still rejects accessible roots with the original filesystem methods", (t) => {
  assert.equal(fs.lstatSync, originalLstat); assert.equal(lstatSync, originalLstat);
  assert.equal(fs.chmodSync, originalChmod); assert.equal(chmodSync, originalChmod);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "router-cold-real-mode-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755);
  assert.notEqual(lstatSync(root).mode & 0o077, 0);
  assert.throws(() => loadColdHookFixture(root), /Fixture root must be private/);
});

test("offline permission model never covers another root", (t) => {
  const f = fixture(t), outside = realpathSync(mkdtempSync(join(tmpdir(), "router-cold-outside-mode-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  chmodSync(outside, 0o755);
  assert.equal(lstatSync(f.root).mode & 0o777, 0o700);
  assert.equal(lstatSync(outside).mode, originalLstat(outside).mode);
  assert.throws(() => loadColdHookFixture(outside), /Fixture root must be private/);
});

test("offline fixture rejects directory link escapes", (t) => {
  const f = fixture(t);
  symlinkSync(tmpdir(), join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => loadColdHookFixture(f.root), /Fixture symlink rejected/);
  rmSync(join(f.root, "escape"));
});

test("offline fixture permits only exact native CLI arg0 file aliases", (t) => {
  const f = fixture(t);
  const dir = join(f.codexHome, "tmp/arg0/codex-arg0offline");
  mkdirSync(dir, { recursive: true });
  try { symlinkSync(f.cliPath, join(dir, "apply_patch")); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Windows file symlink permission is unavailable"); return;
    }
    throw error;
  }
  assert.equal(loadColdHookFixture(f.root).approvalDigest, f.approvalDigest);
  rmSync(join(dir, "apply_patch"));
  symlinkSync(join(f.root, "trust-request.json"), join(dir, "apply_patch"));
  assert.throws(() => loadColdHookFixture(f.root), /outside the reviewed CLI/);
});

test("offline inventory accepts only exact native trusted rows for the requested phase", (t) => {
  const f = fixture(t);
  assert.equal(verifyColdHookInventory(f, "A", inventory(f)).data[0].hooks.length, 7);
  assert.throws(() => verifyColdHookInventory(f, "B", inventory(f)), /differs/);
  for (const [field, value] of [["key", "different"], ["currentHash", `sha256:${"f".repeat(64)}`], ["source", "unknown"], ["sourcePath", "/outside/hooks.json"],
    ["command", "different"], ["enabled", false], ["trustStatus", "untrusted"], ["trustStatus", "modified"], ["trustStatus", "managed"]]) {
    const response = inventory(f); response.data[0].hooks[0][field] = value;
    assert.throws(() => verifyColdHookInventory(f, "A", response), undefined, field);
  }
});

test("offline inventory rejects malformed, duplicate, extra or warning-bearing inventories", (t) => {
  const f = fixture(t);
  for (const change of [(x) => x.data.push(x.data[0]), (x) => x.data[0].hooks.pop(), (x) => x.data[0].hooks.push(x.data[0].hooks[0]),
    (x) => x.data[0].hooks[1] = x.data[0].hooks[0], (x) => x.data[0].errors.push({ message: "bad" }), (x) => x.data[0].warnings.push("unknown config"), (x) => x.data[0].cwd = "/outside"]) {
    const response = inventory(f); change(response); assert.throws(() => verifyColdHookInventory(f, "A", response));
  }
});

test("offline assessment distinguishes parent evidence from unverified later Hooks and child path", (t) => {
  const f = fixture(t), assessment = assessColdHookEvidence(f, evidence(f));
  assert.equal(assessment.status, "passed"); // Synthetic parent-only evidence, not a native smoke result.
  assert.equal(assessment.subsequentHooks.B.preToolUse, "unproven");
  assert.match(assessment.childPath, /unverified/);
  assert.match(assessment.oldEntryRetirement, /^unproven/);
});

test("offline assessment does not turn registration or reload acknowledgements into Hook proof", (t) => {
  const f = fixture(t), data = evidence(f);
  data.phases.B.notifications = [{ method: "config/reloaded", params: { success: true } }];
  data.phases.B.logs = [];
  const assessment = assessColdHookEvidence(f, data);
  assert.equal(assessment.status, "unproven");
  assert.ok(assessment.missing.some((reason) => reason.includes("B: sessionStart")));
});

test("offline assessment requires actual logs plus native completion and same persisted ID", (t) => {
  const f = fixture(t);
  for (const change of [(x) => x.resumedId = "other", (x) => x.coldExitConfirmed = false, (x) => x.persistedPath = "/outside/rollout.jsonl",
    (x) => x.phases.B.logs = [], (x) => x.phases.B.notifications[0].params.run.status = "failed", (x) => x.phases.B.completed.params.turn.status = "failed"]) {
    const data = evidence(f); change(data); assert.equal(assessColdHookEvidence(f, data).status, "unproven");
  }
});

test("offline assessment rejects old A Hook execution after the B boundary and foreign task logs", (t) => {
  const f = fixture(t);
  for (const change of [(x) => x.phases.B.logs.push(log(f, "A")), (x) => x.phases.B.notifications.push(hook(f, "A")),
    (x) => x.phases.B.logs.push(log(f, "B", "other-parent"))]) {
    const data = evidence(f); change(data); assert.equal(assessColdHookEvidence(f, data).status, "failed");
  }
});

test("offline assessment leaves unknown Hook payloads unproven", (t) => {
  const f = fixture(t), data = evidence(f);
  data.phases.B.notifications[0].params.run.source = "unknown";
  data.phases.B.logs[0].input.hook_event_name = "not-a-known-event";
  assert.equal(assessColdHookEvidence(f, data).status, "unproven");
});

test("offline later Hook evidence must match the actual completed probe turn in notification and input", (t) => {
  const f = fixture(t);
  for (const [nativeTurn, inputTurn, expected] of [["turn-B", "turn-B", "observed"], ["old-turn", "old-turn", "unproven"],
    ["turn-B", "old-turn", "unproven"], ["old-turn", "turn-B", "unproven"], [null, null, "unproven"]]) {
    const data = evidence(f), notification = hook(f, "B", "offline-parent", "preToolUse"), input = log(f, "B", "offline-parent", "preToolUse");
    notification.params.turnId = nativeTurn;
    input.input.turn_id = inputTurn;
    data.phases.B.notifications.push(notification);
    data.phases.B.logs.push(input);
    const result = assessColdHookEvidence(f, data);
    assert.equal(result.subsequentHooks.B.preToolUse, expected);
    assert.equal(result.status, "passed", "SessionStart has independent session-level evidence without a turn ID");
    assert.equal(result.scope, "parent-session-start-cold-recovery-only");
  }
});

test("offline process cleanup recognizes a recorded signal exit without waiting for another exit event", async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: "SIGTERM", killed: true });
  let closes = 0;
  await stopOwnedClient({ ownedProcess: child, process: null, close: () => { closes++; } }, 15);
  assert.equal(closes, 1);
  assert.equal(child.listenerCount("exit"), 0);
});

test("offline process cleanup waits for actual exit when killed only means a signal was sent", async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: true });
  let exited = false;
  const pending = stopOwnedClient({ process: child, close: () => {} }, 100).then(() => { exited = true; });
  await Promise.resolve();
  assert.equal(exited, false);
  child.signalCode = "SIGTERM";
  child.emit("exit", null, "SIGTERM");
  await pending;
  assert.equal(exited, true);
});

test("offline process cleanup timeout never claims cold exit from child.killed", async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: true });
  await assert.rejects(stopOwnedClient({ process: child, close: () => {} }, 15), /did not exit/);
  assert.equal(child.listenerCount("exit"), 0);
});

test("offline driver refuses absent, wrong-scope, changed-byte or wrong-stage approval before host startup", async (t) => {
  const f = fixture(t), host = fakeHost(f, "A");
  for (const authorization of [undefined, { ...approval(f), explicitUserApproval: false }, { ...approval(f), root: "/outside" },
    { ...approval(f), approvalDigest: "changed" }, { ...approval(f), nativeTrustApplied: "B" }]) {
    await assert.rejects(runNativeColdHooks({ root: f.root, authorization }, host));
  }
  assert.deepEqual(host.calls, []);
});

test("offline driver blocks untrusted inventory before creating any native task and closes only its injected client", async (t) => {
  const f = fixture(t), response = inventory(f); response.data[0].hooks[0].trustStatus = "untrusted";
  const host = fakeHost(f, "A", { inventory: response });
  const result = await runNativeColdHooks({ root: f.root, authorization: approval(f) }, host);
  assert.deepEqual(host.calls, ["initialize", "hooks/list"]);
  assert.equal(host.closed, 1);
  assert.equal(result.assessment.status, "unproven");
  assert.equal(existsSync(f.eventLog), false);
});

test("offline driver checkpoints A then resumes the same simulated parent only after separate B trust", async (t) => {
  const f = fixture(t), a = fakeHost(f, "A");
  const first = await runNativeColdHooks({ root: f.root, authorization: approval(f) }, a);
  assert.equal(first.state, "awaiting_B_native_trust");
  assert.equal(a.closed, 1);
  assert.equal(first.coldExitConfirmed, true);
  assert.equal(first.reviewedArtifacts.A.script, reviewedProbeScript(f.root, "A"));
  assert.ok(first.reviewedArtifacts.A.cache["hooks/hooks.json"]);
  const untrusted = inventory(f, "B"); untrusted.data[0].hooks[0].trustStatus = "untrusted";
  const blockedHost = fakeHost(f, "B", { inventory: untrusted });
  const blocked = await runNativeColdHooks({ root: f.root, stage: "B", checkpointPath: first.reportPath, authorization: approval(f, "B") }, blockedHost);
  assert.equal(blocked.assessment.status, "unproven");
  assert.deepEqual(blockedHost.calls, ["initialize", "hooks/list"]);
  const b = fakeHost(f, "B");
  const second = await runNativeColdHooks({ root: f.root, stage: "B", checkpointPath: first.reportPath, authorization: approval(f, "B") }, b);
  assert.equal(second.resumedId, first.threadId);
  assert.equal(second.assessment.status, "passed");
  assert.equal(second.assessment.subsequentHooks.B.stop, "unproven");
  assert.equal(second.modelCalls, 0);
  assert.equal(b.closed, 1);
  assert.ok(b.calls.includes("thread/resume"));
  assert.ok(!b.calls.includes("thread/start"));
  assert.ok([...a.calls, ...b.calls].every((method) => !/config\/|plugin\/|turn\/start/.test(method)));
});

test("offline driver treats shell ACK and an unrelated completed turn as insufficient persistence", async (t) => {
  for (const options of [{ ackOnly: true }, { wrongTurn: true }]) {
    const f = fixture(t), host = fakeHost(f, "A", options);
    const result = await runNativeColdHooks({ root: f.root, authorization: approval(f), timeoutMs: 15 }, host);
    assert.equal(result.state, "unproven");
    assert.equal(result.assessment.status, "unproven");
    assert.match(result.error.message, /completion not observed/);
    assert.equal(host.closed, 1);
  }
});

test("offline driver does not create a resumable checkpoint if owned process exit is unconfirmed", async (t) => {
  const f = fixture(t), host = fakeHost(f, "A", { closeFailure: true });
  const result = await runNativeColdHooks({ root: f.root, authorization: approval(f) }, host);
  assert.equal(result.state, "unproven");
  assert.notEqual(result.coldExitConfirmed, true);
  assert.ok(result.cleanupError);
});

test("offline B stage rejects tampered checkpoints and events produced between stopped stages", async (t) => {
  const f = fixture(t), a = await runNativeColdHooks({ root: f.root, authorization: approval(f) }, fakeHost(f, "A"));
  const b = fakeHost(f, "B");
  appendFileSync(f.eventLog, `${JSON.stringify(log(f, "A"))}\n`);
  await assert.rejects(runNativeColdHooks({ root: f.root, stage: "B", checkpointPath: a.reportPath, authorization: approval(f, "B") }, b), /outside the stopped checkpoint/);
  assert.deepEqual(b.calls, []);
});

test("offline native child correlation supports activity and legacy call views without trusting a displayed identity", () => {
  const hooks = [{ input: { hook_event_name: "SubagentStart", session_id: "parent", agent_id: "child" } }];
  const activity = { id: "parent", turns: [{ items: [{ type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/probe" }] }] };
  assert.deepEqual(correlateColdChild(activity, hooks), { id: "child", path: "/root/probe" });
  const legacy = { id: "parent", turns: [{ items: [{ type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", senderThreadId: "parent", receiverThreadIds: ["child"] }] }] };
  assert.deepEqual(correlateColdChild(legacy, hooks), { id: "child", path: null });
  assert.throws(() => correlateColdChild(activity, [{ input: { ...hooks[0].input, agent_id: "other" } }]), /disagree/);
  assert.throws(() => correlateColdChild(activity, []), /SubagentStart/);
  assert.throws(() => correlateColdChild({ ...legacy, id: "another-parent" }, hooks), /one actual native child/);
});

test("actual native parent and original child Hook cold recovery", {
  skip: !process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_RUN && !process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_EVIDENCE && "Opt in with approved native execution materials or captured owned parent/child evidence",
  timeout: 120_000,
}, async (t) => {
  if (process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_EVIDENCE) {
    const result = verifyCapturedColdModelRun(process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_EVIDENCE);
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.status, "passed");
    return;
  }
  // This opt-in file must be prepared by the root AFTER explicit user approval
  // and native config/batchWrite of the selected stage. No trust is written here.
  const options = JSON.parse(readFileSync(process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_RUN, "utf8"));
  const result = await runNativeColdHooks(options);
  t.diagnostic(JSON.stringify({ reportPath: result.reportPath, state: result.state, assessment: result.assessment }));
  if (options.stage === "B") assert.equal(result.assessment.status, "passed", "Native parent cold recovery is unproven; inspect the saved evidence");
  else assert.equal(result.state, "awaiting_B_native_trust", "Native A preparation did not reach a stopped resumable checkpoint");
});

test("real captured native inputs support encrypted checkpoint and same-child continuation parsing", {
  skip: !process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_EVIDENCE && "Requires captured approved native queue and explicit recovery evidence",
}, async (t) => {
  // Replay only: synthetic in-memory ledger, actual byte-preserved source
  // prefixes and actual Hook receipts. No trust, admission or outcome is minted.
  const result = await verifyCapturedMessageCheckpoint(process.env.ADAPTIVE_ROUTER_NATIVE_COLD_HOOK_EVIDENCE);
  assert.equal(result.continuation, "verified");
  assert.equal(result.originalCallUnchanged, true);
  assert.equal(result.originalNativeSourcesUnchanged, true);
  assert.equal(result.productionQualification, false);
  t.diagnostic(JSON.stringify(result));
});
