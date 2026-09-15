import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { AppServerClient } from "../../scripts/lib/app-server.mjs";

export const HOOK_EVENTS = Object.freeze(["sessionStart", "userPromptSubmit", "preToolUse", "postToolUse", "subagentStart", "subagentStop", "stop"]);
export const PENDING_TRUST = "skipped pending trust: explicit A/B Hook approval and exact native trust readback are required";
const PLUGIN = "native-cold-entry-probe@native-cold-evidence";
const SHELL_PROBE = "echo native-cold-hook-persisted";
const INPUT_EVENTS = Object.fromEntries(HOOK_EVENTS.map((name) => [name[0].toUpperCase() + name.slice(1), name]));

export function reviewedProbeScript(root, label) {
  assert.ok(["A", "B"].includes(label));
  return `import {appendFileSync} from "node:fs";\nconst parts=[];for await(const part of process.stdin)parts.push(part);\nconst input=JSON.parse(Buffer.concat(parts).toString("utf8"));\nif(input.cwd!==${JSON.stringify(join(root, "project"))})throw new Error("Isolated Hook project mismatch");\nappendFileSync(${JSON.stringify(join(root, "native-hooks.jsonl"))},JSON.stringify({fixture:${JSON.stringify(label)},input,source:import.meta.url,pid:process.pid})+"\\n",{mode:0o600});\nprocess.stdout.write("{}\\n");\n`;
}

function within(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonical(path) {
  assert.equal(typeof path, "string", "Expected an absolute fixture path");
  assert.ok(isAbsolute(path), "Expected an absolute fixture path");
  assert.equal(realpathSync(path), resolve(path), `Symlink/alias path rejected: ${path}`);
  return resolve(path);
}

function checkTree(path, fixture) {
  const stat = lstatSync(path);
  // Native app-server creates executable aliases in its own arg0 temp folder.
  // Permit only these exact links to the reviewed CLI, never writable data links.
  if (stat.isSymbolicLink() && /^tmp\/arg0\/codex-arg0[^/]+\/(apply_patch|applypatch|codex-execve-wrapper)$/.test(relative(fixture.codexHome, path).split(sep).join("/"))) {
    assert.equal(realpathSync(path), realpathSync(fixture.cliPath), "Native executable alias points outside the reviewed CLI");
    return;
  }
  assert.ok(!stat.isSymbolicLink(), `Fixture symlink rejected: ${path}`);
  if (stat.isDirectory()) for (const name of readdirSync(path)) checkTree(join(path, name), fixture);
  else {
    assert.ok(stat.isFile(), `Non-file fixture entry rejected: ${path}`);
    assert.equal(stat.nlink, 1, `Shared hard link rejected: ${path}`);
  }
}

// This reads review materials. It never prepares, installs, trusts or executes a Hook.
// The approval digest also binds script bytes: a native command hash alone does
// not establish that the script at that command's path stayed unchanged.
export function loadColdHookFixture(root) {
  root = canonical(root);
  const globalHome = resolve(homedir(), ".codex");
  assert.ok(root !== globalHome && !within(globalHome, root) && !within(root, globalHome), "Global Codex home is not an isolated fixture");
  assert.ok((lstatSync(root).mode & 0o077) === 0, "Fixture root must be private (0700)");
  const requestPath = join(root, "trust-request.json");
  canonical(requestPath);
  const requestBytes = readFileSync(requestPath);
  const request = JSON.parse(requestBytes);
  assert.equal(request.schema, "native-cold-entry-trust-request/1");
  assert.equal(request.root, root);
  for (const [field, suffix] of [["codexHome", "codex"], ["project", "project"]]) {
    assert.equal(request[field], join(root, suffix));
    canonical(request[field]);
  }
  assert.equal(request.globalConfigTouched, false);
  assert.equal(request.hooksExecuted, 0);
  assert.equal(request.nativeTasksCreated, 0);
  assert.equal(request.modelCalls, 0);
  assert.ok(isAbsolute(request.cliPath) && isAbsolute(request.node), "Executables must have explicit absolute paths");
  checkTree(root, request);
  const digest = createHash("sha256").update(requestBytes);
  for (const label of ["A", "B"]) {
    const market = join(root, `market-${label}`), plugin = join(market, "plugin");
    const manifest = request.manifests?.[label];
    assert.equal(manifest?.pluginId, PLUGIN);
    assert.ok(isAbsolute(manifest.installedPath) && within(request.codexHome, resolve(manifest.installedPath)), "Installed plugin escaped fixture");
    if (existsSync(manifest.installedPath)) canonical(manifest.installedPath);
    const expected = request.requests?.[label];
    assert.equal(expected?.length, HOOK_EVENTS.length);
    assert.equal(new Set(expected.map((row) => row.key)).size, HOOK_EVENTS.length);
    assert.deepEqual(expected.map((row) => row.eventName).sort(), [...HOOK_EVENTS].sort());
    for (const row of expected) {
      assert.equal(row.pluginId, PLUGIN);
      assert.equal(row.source, "plugin");
      assert.equal(row.sourcePath, join(manifest.installedPath, "hooks/hooks.json"));
      assert.equal(row.command, `${JSON.stringify(request.node)} ${JSON.stringify(join(plugin, "hook.mjs"))}`);
      assert.equal(row.handlerType, "command");
      assert.equal(row.enabled, true);
      assert.match(row.currentHash, /^sha256:[0-9a-f]{64}$/);
    }
    for (const path of [join(market, ".agents/plugins/marketplace.json"), join(plugin, ".codex-plugin/plugin.json"), join(plugin, "hooks/hooks.json"), join(plugin, "hook.mjs")]) {
      digest.update(relative(root, path)).update("\0").update(readFileSync(canonical(path))).update("\0");
    }
    assert.equal(readFileSync(join(plugin, "hook.mjs"), "utf8"), reviewedProbeScript(root, label), "Hook script differs from the fixed reviewed probe template");
    const definitions = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8"));
    assert.deepEqual(definitions, { hooks: Object.fromEntries(Object.keys(INPUT_EVENTS).map((event) => [event, [{ matcher: ".*", hooks: [{ type: "command", command: expected[0].command, timeout: 10 }] }]])) }, "Hook definitions differ from the reviewed probe template");
    const installedHooks = join(manifest.installedPath, "hooks/hooks.json");
    if (existsSync(installedHooks)) assert.deepEqual(readFileSync(installedHooks), readFileSync(join(plugin, "hooks/hooks.json")), "Installed and reviewed Hook definitions differ");
  }
  return { ...request, approvalDigest: `sha256:${digest.digest("hex")}`, eventLog: join(root, "native-hooks.jsonl") };
}

export function verifyColdHookInventory(fixture, label, response) {
  assert.equal(response?.data?.length, 1, "Exactly one project inventory is required");
  const entry = response.data[0];
  assert.equal(entry.cwd, fixture.project);
  assert.deepEqual(entry.errors, [], "Native Hook inventory contains errors");
  assert.deepEqual(entry.warnings, [], "Native Hook inventory contains warnings");
  assert.equal(entry.hooks?.length, HOOK_EVENTS.length, "Missing or unexpected Hook definitions");
  assert.equal(new Set(entry.hooks.map((row) => row.key)).size, HOOK_EVENTS.length, "Duplicate Hook key");
  for (const expected of fixture.requests[label]) {
    const actual = entry.hooks.find((row) => row.key === expected.key);
    assert.ok(actual, `Missing Hook key: ${expected.key}`);
    for (const field of ["key", "eventName", "handlerType", "command", "async", "matcher", "timeoutSec", "sourcePath", "source", "pluginId", "enabled", "isManaged", "currentHash"]) {
      assert.deepEqual(actual[field], expected[field], `${label} Hook ${field} differs from reviewed definition`);
    }
    assert.equal(actual.trustStatus, "trusted", `${label} Hook is not natively trusted at its exact reviewed hash`);
  }
  return response;
}

function readHookLog(fixture) {
  if (!existsSync(fixture.eventLog)) return [];
  return readFileSync(fixture.eventLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// An inventory/reload/install receipt is deliberately not an input to this
// evaluator. Only observed events from the owned native task can prove a probe.
export function assessColdHookEvidence(fixture, evidence) {
  const missing = [], conflicts = [], subsequent = {};
  if (!evidence.threadId || evidence.resumedId !== evidence.threadId) missing.push("same persisted native parent task ID");
  if (!evidence.persistedPath || !within(fixture.codexHome, evidence.persistedPath)) missing.push("native persisted task path inside isolated CODEX_HOME");
  if (evidence.coldExitConfirmed !== true) missing.push("first owned app-server exit before cold resume");
  for (const label of ["A", "B"]) {
    subsequent[label] = {};
    const phase = evidence.phases?.[label] || {};
    if (phase.completed?.params?.threadId !== evidence.threadId || phase.completed?.params?.turn?.status !== "completed") missing.push(`${label}: completed native probe turn`);
    const notifications = (phase.notifications || []).filter((item) => item.method === "hook/completed" && item.params?.threadId === evidence.threadId);
    const logs = phase.logs || [];
    for (const item of notifications) {
      const run = item.params.run;
      if (!run || run.source !== "plugin" || !HOOK_EVENTS.includes(run.eventName)) missing.push(`${label}: unknown native Hook event/source`);
      else if (run.sourcePath !== fixture.requests[label].find((row) => row.eventName === run.eventName)?.sourcePath) conflicts.push(`${label}: unexpected native Hook source ${run.sourcePath}`);
    }
    for (const row of logs) {
      if (row.fixture !== label) conflicts.push(`${label}: observed ${row.fixture} Hook after phase boundary`);
      if (!Object.hasOwn(INPUT_EVENTS, row.input?.hook_event_name)) missing.push(`${label}: unknown Hook input event`);
      if (row.input?.session_id !== evidence.threadId || row.input?.cwd !== fixture.project) conflicts.push(`${label}: Hook log is not from the owned parent/project`);
    }
    for (const event of HOOK_EVENTS) {
      const definition = fixture.requests[label].find((row) => row.eventName === event);
      const turnId = phase.completed?.params?.turn?.id;
      const native = notifications.some(({ params }) => params.run?.eventName === event && params.run?.status === "completed" && params.run?.source === "plugin" && params.run?.sourcePath === definition.sourcePath && typeof params.run?.id === "string" && params.run.id.length > 0
        && (event === "sessionStart" || (turnId && params.turnId === turnId)));
      const logged = logs.some((row) => row.fixture === label && row.source === pathToFileURL(join(fixture.root, `market-${label}/plugin/hook.mjs`)).href && row.input?.session_id === evidence.threadId && row.input?.cwd === fixture.project && INPUT_EVENTS[row.input?.hook_event_name] === event
        && (event === "sessionStart" || (turnId && row.input.turn_id === turnId)));
      if (event !== "sessionStart") subsequent[label][event] = native && logged ? "observed" : "unproven";
      else if (!native || !logged) missing.push(`${label}: ${event} ${!native ? "native completion" : ""}${!native && !logged ? " and " : ""}${!logged ? "actual Hook log" : ""}`);
    }
  }
  return { scope: "parent-session-start-cold-recovery-only", status: conflicts.length ? "failed" : missing.length ? "unproven" : "passed", missing: [...new Set(missing)], conflicts: [...new Set(conflicts)],
    subsequentHooks: subsequent, childPath: "unverified: no model inference or subagent was requested",
    oldEntryRetirement: "unproven: parent SessionStart evidence alone does not retire every old entry" };
}

// Native App Server has both collabAgentToolCall and subAgentActivity views.
// A displayed activity alone never proves a child: correlate the actual Hook
// identity and keep the native UUID distinct from its canonical agent path.
export function correlateColdChild(parent, hookRows) {
  const items = (parent.turns || []).flatMap((turn) => turn.items || []);
  const starts = items.flatMap((item) => item.type === "subAgentActivity" && item.kind === "started"
    ? [{ id: item.agentThreadId, path: item.agentPath }]
    : item.type === "collabAgentToolCall" && /spawn/i.test(item.tool) && item.status === "completed" && item.senderThreadId === parent.id
      ? item.receiverThreadIds.map((id) => ({ id, path: null })) : []);
  const ids = [...new Set(starts.map((item) => item.id))];
  assert.equal(ids.length, 1, "Exactly one actual native child must be identified");
  const start = hookRows.filter((row) => row.input?.hook_event_name === "SubagentStart");
  assert.equal(start.length, 1, "Exactly one correlated native SubagentStart is required");
  assert.equal(start[0].input.session_id, parent.id, "Child belongs to another parent");
  assert.equal(start[0].input.agent_id, ids[0], "Native child activity and Hook disagree");
  return { id: ids[0], path: starts.find((item) => item.path)?.path || null };
}

// Read-only validation of a previously executed, owned native smoke. These
// captures prove the generic Hook entry contract, never Router qualification.
// This does not send a prompt, apply trust, or treat a JSON status as proof.
export function verifyCapturedColdModelRun(root) {
  const fixture = loadColdHookFixture(root);
  const read = (name) => {
    const path = join(fixture.root, name);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const a = read("model-AB-A-verified-report.json"), b = read("model-AB-B-report.json");
  const child = correlateColdChild(a.parent, a.actualHookRows);
  assert.equal(a.approvalDigest, fixture.approvalDigest); assert.equal(b.approvalDigest, fixture.approvalDigest);
  assert.equal(a.threadId, b.threadId); assert.equal(a.persistedPath, b.persistedPath);
  assert.equal(a.childId, child.id); assert.equal(b.childId, child.id);
  assert.equal(a.child.path, b.child.path); assert.equal(b.child.parentThreadId, a.threadId);
  const nativeLines = (path) => {
    assert.ok(within(fixture.codexHome, canonical(path)), "Native transcript escaped the isolated home");
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  };
  const rootLines = nativeLines(b.persistedPath), childLines = nativeLines(b.child.path);
  assert.equal(rootLines[0].payload.id, a.threadId); assert.equal(childLines[0].payload.id, child.id);
  const log = readFileSync(fixture.eventLog);
  const phaseTimes = {};
  for (const [stage, result] of [["A", a], ["B", b]]) {
    verifyColdHookInventory(fixture, stage, result.trusted);
    const raw = readFileSync(join(fixture.root, `model-AB-${stage}-rpc.jsonl`), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const responses = raw.filter((row) => row.direction === "response").map((row) => JSON.parse(row.raw));
    const requests = raw.filter((row) => row.direction === "request").map((row) => row.message);
    phaseTimes[stage] = { firstStart: Math.min(...raw.filter((row) => row.type === "owned-start").map((row) => Date.parse(row.at))),
      lastExit: Math.max(...raw.filter((row) => row.type === "owned-exit").map((row) => Date.parse(row.at))) };
    const completed = result.completed;
    assert.ok(responses.some((row) => JSON.stringify(row) === JSON.stringify(completed)), "Completion is absent from owned native RPC");
    assert.equal(completed.params.threadId, a.threadId); assert.equal(completed.params.turn.status, "completed");
    assert.ok(rootLines.some((row) => row.type === "event_msg" && row.payload.type === "task_complete" && row.payload.turn_id === completed.params.turn.id));
    assert.ok(requests.some((row) => row.method === (stage === "A" ? "thread/start" : "thread/resume")
      && (stage === "A" || row.params.threadId === a.threadId)));
    if (stage === "B") assert.ok(!requests.some((row) => row.method === "thread/start"), "B must restore the original parent");
    for (const process of result.ownedProcesses) {
      assert.equal(process.command, fixture.cliPath);
      assert.ok(raw.some((row) => row.type === "owned-start" && row.pid === process.pid && row.command === fixture.cliPath));
      assert.ok(raw.some((row) => row.type === "owned-exit" && row.pid === process.pid
        && (typeof row.code === "number" || typeof row.signal === "string")), "A sent signal does not prove process exit");
    }
    const rows = log.subarray(result.hookLogOffset).toString().split("\n").filter(Boolean).slice(0, result.actualHookRows.length).map(JSON.parse);
    assert.deepEqual(rows, result.actualHookRows, "Original Hook log prefix changed");
    for (const row of rows) {
      assert.equal(row.fixture, stage); assert.equal(row.source, pathToFileURL(join(fixture.root, `market-${stage}/plugin/hook.mjs`)).href);
      assert.equal(row.input.cwd, fixture.project); assert.equal(row.input.session_id, a.threadId);
      const event = INPUT_EVENTS[row.input.hook_event_name]; assert.ok(event);
      const definition = fixture.requests[stage].find((entry) => entry.eventName === event);
      assert.ok(responses.some((entry) => entry.method === "hook/completed" && entry.params?.run?.eventName === event
        && entry.params.run.status === "completed" && entry.params.run.sourcePath === definition.sourcePath
        && (!row.input.turn_id || entry.params.turnId === row.input.turn_id)), "Hook log lacks matching native completion");
    }
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      assert.ok(rows.some((row) => row.input.hook_event_name === event && !row.input.agent_id
        && (event === "SessionStart" || row.input.turn_id === completed.params.turn.id)), `Missing ${stage} parent ${event}`);
    }
    const finalTurn = result.child.turns.at(-1), expected = stage === "A" ? "CHILD_A_READY" : "CHILD_B_FOLLOWUP_DONE";
    assert.equal(finalTurn.status, "completed");
    assert.ok(finalTurn.items.some((item) => item.type === "agentMessage" && item.phase === "final_answer" && item.text === expected));
    assert.ok(childLines.some((row) => row.type === "event_msg" && row.payload.type === "task_complete"
      && row.payload.turn_id === finalTurn.id && row.payload.last_agent_message === expected), "Child final lacks native completion");
    assert.ok(rows.some((row) => row.input.hook_event_name === "SubagentStop" && row.input.agent_id === child.id
      && row.input.turn_id === finalTurn.id && row.input.last_assistant_message === expected));
    if (stage === "B") {
      assert.ok(!rows.some((row) => row.input.hook_event_name === "SubagentStart"));
      for (const event of ["PreToolUse", "PostToolUse"]) assert.ok(rows.some((row) => row.input.hook_event_name === event
        && row.input.agent_id === child.id && row.input.turn_id === finalTurn.id && row.input.tool_input?.command === "echo ROUTER_CHILD_B_TOOL"));
      assert.ok(finalTurn.items.some((item) => item.type === "commandExecution" && item.status === "completed" && item.exitCode === 0
        && item.aggregatedOutput === "ROUTER_CHILD_B_TOOL\n"));
      assert.ok(result.parent.turns.at(-1).items.some((item) => item.type === "subAgentActivity" && item.kind === "interacted" && item.agentThreadId === child.id));
    }
  }
  assert.ok(Number.isFinite(phaseTimes.A.lastExit) && Number.isFinite(phaseTimes.B.firstStart)
    && phaseTimes.A.lastExit < phaseTimes.B.firstStart, "A owned processes must actually exit before B starts");
  return { scope: "captured-generic-native-parent-child-cold-entry", status: "passed", parent: a.threadId, child: child.id,
    currentRouterBusinessQualification: "not_proven_by_this_probe", queuedInputPersistence: "separate_required_test" };
}

function isolatedEnvironment(fixture) {
  // Do not inherit Hook/router flags, NODE_OPTIONS, global config overrides,
  // credentials, or a running task's identity. The prepared CODEX_HOME owns auth.
  const env = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) if (process.env[name]) env[name] = process.env[name];
  return { ...env, HOME: fixture.root, USERPROFILE: fixture.root, XDG_CONFIG_HOME: fixture.codexHome, CODEX_HOME: fixture.codexHome,
    CODEX_SQLITE_HOME: fixture.codexHome, CODEX_THREAD_ID: "", ADAPTIVE_ROUTER_INVOCATION_ID: "", ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
    ADAPTIVE_ROUTER_HOME: join(fixture.root, "router-state"), PLUGIN_DATA: join(fixture.root, "router-state") };
}

export function nativeClient(fixture, timeoutMs, spawnProcess = spawn) {
  const client = new AppServerClient({ timeoutMs, resolveImpl: async () => ({ path: fixture.cliPath, kind: "direct" }),
    spawnImpl: (command, args, options) => {
      // spawnSpec uses a basename plus a prepended PATH. The isolated environment
      // intentionally replaces that PATH, so bind the reviewed executable here.
      client.ownedProcess = spawnProcess(fixture.cliPath, args, { ...options, env: isolatedEnvironment(fixture), cwd: fixture.project });
      return client.ownedProcess;
    } });
  return client;
}

export async function stopOwnedClient(client, timeoutMs) {
  if (!client) return;
  const child = client.ownedProcess || client.process;
  if (!child || child.exitCode != null || child.signalCode != null) { client.close(); return; }
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Owned app-server did not exit; cold recovery is unproven")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); child.removeListener("exit", onExit); };
    const onExit = () => { cleanup(); resolveExit(); };
    child.once("exit", onExit);
    client.close(); // Only the process created by this client; never process-name kills.
  });
}

async function probe(client, threadId, timeoutMs) {
  // Subscribe before dispatch, without AppServerClient's stale notification
  // buffer: the shell RPC has no turn ID in its acknowledgement.
  const messages = [];
  let wake, startedTurnId = null;
  const waiter = new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => reject(new Error("Native probe turn completion not observed")), timeoutMs);
    wake = (message) => {
      if (message.params?.threadId !== threadId) return;
      if (message.method === "turn/started") startedTurnId = message.params.turn?.id;
      if (message.method === "turn/completed" && startedTurnId && message.params.turn?.id === startedTurnId) { clearTimeout(timer); resolveWait(message); }
    };
    wake.cancel = () => clearTimeout(timer);
  });
  waiter.catch(() => {});
  const unsubscribe = client.subscribe((message) => { messages.push(message); wake(message); });
  try {
    const ack = await client.request("thread/shellCommand", { threadId, command: SHELL_PROBE, timeoutMs: 2_000 });
    const completed = await waiter;
    assert.equal(completed.params.turn?.status, "completed", "Native probe turn did not succeed");
    return { ack, completed, turnNotifications: messages };
  } finally { wake.cancel(); unsubscribe(); }
}

/** Future opt-in entry point. Run stage A, then let the root apply the already
 * approved B installation/trusted_hash using native APIs, then run stage B with
 * checkpointPath. Each key holds one trusted_hash: A and B cannot be pretrusted
 * simultaneously. This driver never writes trust or changes plugin registration.
 * Approval is external user authorization bound to reviewed bytes, NOT trust. */
export async function runNativeColdHooks({ root, authorization, stage = "A", checkpointPath, timeoutMs = 30_000 }, dependencies = {}) {
  const fixture = loadColdHookFixture(root);
  assert.ok(["A", "B"].includes(stage), "Unknown cold Hook stage");
  assert.equal(authorization?.explicitUserApproval, true, PENDING_TRUST);
  assert.equal(authorization?.root, fixture.root, "Approval scope differs from fixture");
  assert.equal(authorization?.approvalDigest, fixture.approvalDigest, "Review bytes changed; renewed approval required");
  assert.equal(authorization?.nativeTrustApplied, stage, "The root must apply this stage's exact native config/batchWrite trust outside this driver");
  let prior = null;
  if (stage === "A") assert.equal(readHookLog(fixture).length, 0, "Use a fresh prepared fixture; do not mix prior Hook evidence");
  else {
    canonical(checkpointPath);
    assert.ok(within(fixture.root, checkpointPath) && /^native-cold-run-[^/\\]+\.json$/.test(relative(fixture.root, checkpointPath)), "Checkpoint must be an owned fixture report");
    prior = JSON.parse(readFileSync(checkpointPath, "utf8"));
    assert.equal(prior.schema, "native-cold-hook-evidence/1");
    assert.equal(prior.stage, "A");
    assert.equal(prior.state, "awaiting_B_native_trust");
    assert.equal(prior.approvalDigest, fixture.approvalDigest);
    assert.equal(prior.coldExitConfirmed, true);
    assert.ok(prior.threadId && within(fixture.codexHome, canonical(prior.persistedPath)), "Checkpoint lacks isolated native persistence");
    assert.deepEqual(readHookLog(fixture), prior.rawHookLog, "Hook events appeared outside the stopped checkpoint");
  }
  const reportPath = join(fixture.root, `native-cold-run-${randomUUID()}.json`);
  const evidence = { schema: "native-cold-hook-evidence/1", stage, approvalDigest: fixture.approvalDigest, modelCalls: 0,
    phases: prior ? structuredClone(prior.phases) : {}, inventories: [], notifications: [],
    ...(prior ? { threadId: prior.threadId, persistedPath: prior.persistedPath, coldExitConfirmed: prior.coldExitConfirmed, priorCheckpoint: checkpointPath } : {}) };
  const makeClient = dependencies.clientFactory || (() => nativeClient(fixture, timeoutMs));
  const closeClient = dependencies.closeClient || ((client) => stopOwnedClient(client, timeoutMs));
  let client = null;
  const boundary = readHookLog(fixture).length;
  try {
    // Keep source/cache bytes as evidence before the root changes installation.
    evidence.reviewedArtifacts = {};
    for (const label of ["A", "B"]) {
      const plugin = join(fixture.root, `market-${label}/plugin`);
      evidence.reviewedArtifacts[label] = { manifest: fixture.manifests[label], script: readFileSync(join(plugin, "hook.mjs"), "utf8"),
        definitions: readFileSync(join(plugin, "hooks/hooks.json"), "utf8"), cache: {} };
      for (const name of [".codex-plugin/plugin.json", "hooks/hooks.json", "hook.mjs"]) {
        const path = join(fixture.manifests[label].installedPath, name);
        if (existsSync(path)) evidence.reviewedArtifacts[label].cache[name] = readFileSync(path, "utf8");
      }
    }
    client = makeClient(fixture);
    client.subscribe((message) => evidence.notifications.push(message));
    await client.start();
    const inventory = await client.request("hooks/list", { cwds: [fixture.project] });
    evidence.inventories.push({ label: stage, response: inventory });
    verifyColdHookInventory(fixture, stage, inventory);
    assert.equal(loadColdHookFixture(root).approvalDigest, fixture.approvalDigest, "Review bytes changed before task dispatch");
    if (stage === "A") {
      const started = await client.request("thread/start", { cwd: fixture.project, ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
      evidence.started = started;
      evidence.threadId = started.thread?.id;
      assert.ok(evidence.threadId, "Native parent did not start");
    } else {
      const persisted = await client.request("thread/read", { threadId: evidence.threadId, includeTurns: false });
      assert.equal(persisted.thread?.id, evidence.threadId);
      assert.equal(canonical(persisted.thread.path), evidence.persistedPath, "Native source changed since stage A");
      const resumed = await client.request("thread/resume", { threadId: evidence.threadId, cwd: fixture.project, excludeTurns: true, approvalPolicy: "never", sandbox: "read-only" });
      evidence.resumed = resumed;
      evidence.resumedId = resumed.thread?.id;
      assert.equal(evidence.resumedId, evidence.threadId, "Cold resume changed the native task ID");
    }
    evidence.phases[stage] = await probe(client, evidence.threadId, timeoutMs);
    const persisted = await client.request("thread/read", { threadId: evidence.threadId, includeTurns: false });
    evidence.persisted = persisted;
    assert.equal(persisted.thread?.id, evidence.threadId);
    const persistedPath = canonical(persisted.thread.path);
    assert.ok(within(fixture.codexHome, persistedPath), "Native task persistence escaped fixture");
    assert.ok(lstatSync(persistedPath).size > 0, "Native task was not persisted");
    if (stage === "B") assert.equal(persistedPath, evidence.persistedPath);
    evidence.persistedPath = persistedPath;
    await closeClient(client);
    client = null;
    evidence.coldExitConfirmed = true;
    assert.equal(loadColdHookFixture(root).approvalDigest, fixture.approvalDigest, "Reviewed A/B source bytes changed during the probe");
    evidence.state = stage === "A" ? "awaiting_B_native_trust" : "completed_probe";
  } catch (error) {
    evidence.error = { name: error.name, message: error.message };
    evidence.state = "unproven";
  } finally {
    if (client) {
      try { await closeClient(client); } catch (error) { evidence.cleanupError = error.message; evidence.state = "unproven"; }
    }
    evidence.phases[stage] ||= {};
    evidence.phases[stage].notifications = evidence.notifications;
    try {
      evidence.rawHookLog = readHookLog(fixture);
      evidence.phases[stage].logs = evidence.rawHookLog.slice(boundary);
    } catch (error) { evidence.logError = error.message; evidence.state = "unproven"; }
    evidence.assessment = assessColdHookEvidence(fixture, evidence);
    if ((evidence.error || evidence.cleanupError || evidence.logError) && evidence.assessment.status !== "failed") evidence.assessment.status = "unproven";
    writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return { reportPath, ...evidence };
}
