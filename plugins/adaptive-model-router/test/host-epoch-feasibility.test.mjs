import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";

// P0 feasibility, not an implementation or qualification of the future epoch.
// A is the entire unmodified committed package, never a copy of today's code.
// B is a disposable snapshot of today's package. Only its reachability probe
// gets instrumentation; the database interop test uses its unmodified store.
const BASELINE = "16c439dd0bf3657ba06707ff15c1465613d49554";
// Executable historical-source contract: CI fetch-depth: 0, or explicitly run
// git fetch origin 16c439dd0bf3657ba06707ff15c1465613d49554 in a shallow checkout.
// No network fetch, live cache substitution or skipped baseline is done here.
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(source, "../..");
const importLib = (root, name) => import(pathToFileURL(join(root, "scripts/lib", `${name}.mjs`)).href);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let workspace, a, b, bStore, old, helpers, sourceAtStart;

before(async (t) => {
  sourceAtStart = runtimeSourceDigest(source);
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "router-host-epoch-feasibility-")));
  const archive = spawnSync("git", ["archive", BASELINE, "plugins/adaptive-model-router"],
    { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(archive.status, 0, `Required historical git object ${BASELINE} is missing; use the explicit fetch contract in this test. ${String(archive.stderr)}`);
  const unpacked = spawnSync("tar", ["-xf", "-", "-C", workspace], { input: archive.stdout });
  assert.equal(unpacked.status, 0, String(unpacked.stderr));
  const aRoot = join(workspace, "plugins/adaptive-model-router");
  old = Object.fromEntries(await Promise.all(["database", "runtime-package", "runtime-host-entry", "runtime-isolation", "runtime-dispatch",
    "runtime-lifecycle", "runtime-loader", "runtime-compatibility", "lifecycle-qualification", "router",
    "delegation-gate", "stage-closure", "private-state", "tool-contract-compatibility", "service", "io"]
    .map(async (name) => [name, await importLib(aRoot, name)])));
  a = old["runtime-package"].inspectRuntimePackage(aRoot);
  helpers = await import(pathToFileURL(join(aRoot, "test/fixtures.mjs")).href);
  const current = join(workspace, "current-store");
  cpSync(source, current, { recursive: true });
  bStore = (await importLib(current, "database")).RouterStore;
  const probe = join(workspace, "candidate-probe");
  cpSync(current, probe, { recursive: true });
  const hookPath = join(probe, "scripts/hook.mjs");
  writeFileSync(hookPath, readFileSync(hookPath, "utf8") +
    '\nprocess.stderr.write("EPOCH_PROBE_B_HOOK:" + process.env.ADAPTIVE_ROUTER_INVOCATION_ID + "\\n");\n');
  const qualificationPath = join(probe, "scripts/lib/lifecycle-qualification.mjs");
  writeFileSync(qualificationPath, readFileSync(qualificationPath, "utf8") +
    '\nexport const epochFeasibilityProbe = "candidate-qualification-module";\n');
  writeFileSync(join(probe, "scripts/epoch-probe-service.mjs"), `
import * as service from "./lib/service.mjs";
export const TOOL_DEFINITIONS = service.TOOL_DEFINITIONS;
export const createServiceStore = service.createServiceStore;
export async function callRouterTool(name, args, options) {
  const value = await service.callRouterTool(name, args, options);
  return { ...value, epochFeasibilityProbe: "candidate-service", invocation: options.store.runtimeInvocation };
}
`);
  const descriptor = JSON.parse(readFileSync(join(probe, "runtime.json"), "utf8"));
  descriptor.entrypoints.service = "scripts/epoch-probe-service.mjs";
  writeFileSync(join(probe, "runtime.json"), JSON.stringify(descriptor));
  b = old["runtime-package"].inspectRuntimePackage(probe);
  t.diagnostic(JSON.stringify({ sourceAtStart, frozenA: a.digest, instrumentedB: b.digest }));
});

after((t) => {
  try {
    const sourceAtEnd = runtimeSourceDigest(source);
    t.diagnostic(JSON.stringify({ sourceAtStart, sourceAtEnd }));
    assert.equal(sourceAtEnd, sourceAtStart, "Source changed during fixture run; repeat with a stable snapshot before interpreting compatibility results");
    if (a) assert.equal(old["runtime-package"].inspectRuntimePackage(a.root).digest, a.digest,
      "every A byte, including its launcher, dispatcher, MCP, store and reader, must remain frozen");
  } finally { if (workspace) rmSync(workspace, { recursive: true, force: true }); }
});

async function fixture(run) {
  const root = mkdtempSync(join(workspace, "case-"));
  const home = join(root, "state");
  const environment = { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home, CODEX_HOME: join(root, "codex"),
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "",
    PLUGIN_ROOT: a.root, ADAPTIVE_ROUTER_SHELL_ROOT: a.root, ADAPTIVE_ROUTER_NODE: process.execPath };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const store = new old.database.RouterStore();
  try {
    store.transaction(() => old["runtime-isolation"].publishRuntime(store.db, a, home, { bootstrap: true, shellRoot: a.root }));
    const context = store.context({ cwd: root, contextId: "owner", authoritative: true });
    store.transaction(() => old["runtime-isolation"].ensureRuntimeTask(store.db, context, { trustedHook: true, turnId: "turn-a" }));
    // Deliberate test-only registry injection isolates reachability from admission.
    // It does NOT certify, publish or migrate B through the production protocol.
    store.transaction(() => store.db.prepare("INSERT INTO runtime_generations(digest,record,state) VALUES(?,?,'published')")
      .run(b.digest, JSON.stringify(b)));
    await run({ root, home, store, context });
  } finally {
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function selectTask(f, generation) {
  f.store.db.prepare("UPDATE runtime_tasks SET generation=? WHERE project_id=? AND context_key=?")
    .run(generation, f.context.projectId, f.context.contextKey);
}

function hook(f, input, { direct = false, shellRoot = a.root } = {}) {
  return spawnSync(process.execPath, [...(direct ? [] : [join(shellRoot, "scripts/node-launcher.mjs")]),
    join(shellRoot, "scripts/hook.mjs"), "session-start"], {
    cwd: f.root, env: process.env, encoding: "utf8", timeout: 15_000,
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "owner", turn_id: "turn-a", cwd: f.root,
      model: "gpt-6-astra", ...input }),
  });
}

async function rpcStatus(f, shellRoot = a.root) {
  const child = spawn(process.execPath, [join(shellRoot, "scripts/node-launcher.mjs"), join(shellRoot, "scripts/mcp-server.mjs")], {
    cwd: f.root, env: { ...process.env, CODEX_THREAD_ID: "owner" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const lines = createInterface({ input: child.stdout });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`old MCP timed out: ${errors}`)); }, 15_000);
    lines.once("line", (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`old MCP exited before response: ${errors}`)); });
  });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "get_route_status", arguments: { contextId: "owner" } } }) + "\n");
  try { const result = await response; await completed; return result; }
  finally { lines.close(); if (child.exitCode === null) child.kill(); }
}

test("frozen A v2 really reaches selected B Hook, service and qualification, without certifying epoch admission", async () => {
  await fixture(async (f) => {
    assert.equal(a.descriptor.shellProtocolVersion, 2);
    assert.notEqual(a.writerDigest, b.writerDigest);
    assert.throws(() => old["runtime-compatibility"].qualifyRuntimeCompatibility(a, b), /separate compatibility epoch/);
    assert.throws(() => f.store.transaction(() => old["runtime-isolation"].publishRuntime(f.store.db, b, f.home)),
      /executable shared-writer qualification/);
    f.store.transaction(() => selectTask(f, b.digest));
    const launched = hook(f);
    assert.equal(launched.status, 0, launched.stderr);
    const invocationId = /EPOCH_PROBE_B_HOOK:([^\s]+)/u.exec(launched.stderr)?.[1];
    assert.ok(invocationId, launched.stderr);
    assert.deepEqual({ ...f.store.db.prepare("SELECT generation,state FROM runtime_invocations WHERE id=?").get(invocationId) },
      { generation: b.digest, state: "completed" });
    const response = await rpcStatus(f);
    assert.equal(response.result?.isError, false, JSON.stringify(response));
    assert.equal(response.result.structuredContent.epochFeasibilityProbe, "candidate-service");
    assert.equal(response.result.structuredContent.invocation.generation, b.digest);
    const qualification = await old["runtime-lifecycle"].createRuntimeLifecycleProbe(b, a.root, {
      inspect: async (options) => ({ selectedModule: options.lifecycle.epochFeasibilityProbe,
        actualShell: options.pluginRoot, nativeHost: options.nativeHost === options.lifecycle.nativeQualificationHost }),
    })({ store: f.store, context: f.context, contextId: "owner", cwd: f.root });
    assert.deepEqual(qualification, { selectedModule: "candidate-qualification-module", actualShell: a.root, nativeHost: true });
    assert.equal(old["runtime-isolation"].runtimeTask(f.store.db, f.context).candidate, null);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("A's real prepared stable entry keeps its executable bytes and reaches B through the materialized lifecycle branch", async () => {
  await fixture(async (f) => {
    const shell = old["runtime-host-entry"].prepareRuntimeHostEntry(a.root, join(f.root, "marketplace/stable-shell"), f.home);
    for (const file of ["scripts/node-launcher.mjs", "scripts/hook.mjs", "scripts/mcp-server.mjs",
      "scripts/lib/runtime-dispatch.mjs", "scripts/lib/runtime-lifecycle.mjs", "scripts/lib/database.mjs"]) {
      assert.deepEqual(readFileSync(join(shell.root, file)), readFileSync(join(a.root, file)));
    }
    f.store.transaction(() => {
      f.store.db.prepare("INSERT INTO runtime_generations(digest,record,state) VALUES(?,?,'published')").run(shell.digest, JSON.stringify(shell));
      f.store.db.prepare("INSERT INTO runtime_host_entries(path,generation,state) VALUES(?,?,'referenced')").run(shell.root, shell.digest);
      selectTask(f, b.digest);
    });
    const launched = hook(f, {}, { shellRoot: shell.root });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stderr, /EPOCH_PROBE_B_HOOK:/u);
    const response = await rpcStatus(f, shell.root);
    assert.equal(response.result?.isError, false, JSON.stringify(response));
    assert.equal(response.result.structuredContent.epochFeasibilityProbe, "candidate-service");
    const lifecycle = await importLib(shell.root, "runtime-lifecycle");
    const selected = await lifecycle.createRuntimeLifecycleProbe(b, shell.root, {
      inspect: async (options) => ({ selectedModule: options.lifecycle.epochFeasibilityProbe,
        actualShell: options.pluginRoot, retained: options.retainedShellRoots.includes(shell.root),
        equivalentEntriesAvailable: typeof options.equivalentEntries === "function" }),
    })({ store: f.store, context: f.context, contextId: "owner", cwd: f.root });
    assert.deepEqual(selected, { selectedModule: "candidate-qualification-module", actualShell: shell.root,
      retained: true, equivalentEntriesAvailable: true });
    assert.equal(old["runtime-package"].inspectRuntimePackage(shell.root).digest, shell.digest);
  });
});

test("old descriptor/tool/candidate readers cannot be extended by adding an epoch field or claiming a new passed proof", async () => {
  const parse = old["runtime-loader"].parseRuntimeDescriptor;
  assert.deepEqual(parse(b.descriptor), b.descriptor);
  assert.throws(() => parse({ ...b.descriptor, compatibilityEpoch: 1 }), /unsupported shape/);
  assert.throws(() => parse({ ...b.descriptor, entrypoints: { ...b.descriptor.entrypoints, qualification: "scripts/q.mjs" } }), /unsupported shape/);
  const definitions = old.service.TOOL_DEFINITIONS;
  assert.equal(old["tool-contract-compatibility"].compatibleToolDefinitions(definitions,
    [...definitions, { name: "accept_host_epoch", inputSchema: { type: "object" } }]), false);
  await fixture(async (f) => {
    f.store.db.prepare("UPDATE runtime_tasks SET candidate=? WHERE project_id=? AND context_key=?")
      .run(b.digest, f.context.projectId, f.context.contextKey);
    const context = { ...f.context, runtimeDigest: b.digest };
    const futureProof = { schema: 2, state: "passed", capability: "child-lifecycle/1", routeId: "not-a-qualification" };
    const settle = () => f.store.transaction(() => old["runtime-isolation"].settleRuntimeMigration(f.store.db, f.context,
      { candidateQualification: futureProof, candidateReady: true }));
    assert.deepEqual(settle(), { state: "blocked", pending: ["candidate_qualification_unproven"] });
    const key = old["lifecycle-qualification"].taskQualificationKey(context);
    f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify(futureProof));
    assert.deepEqual(old["lifecycle-qualification"].readTaskQualification(f.store.db, context), { state: "invalid" });
    assert.equal(old["lifecycle-qualification"].verifiedRuntimeQualification(f.store.db, context), null);
    assert.deepEqual(settle(), { state: "blocked", pending: ["candidate_qualification_unproven"] });
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key).value, JSON.stringify(futureProof));
    // A MCP's private settleCandidate uses these frozen imports before dispatch.
    const mcp = readFileSync(join(a.root, "scripts/mcp-server.mjs"), "utf8");
    assert.match(mcp, /settleRuntimeMigration \} from "\.\/lib\/runtime-isolation\.mjs"/u);
    assert.match(mcp, /await settleCandidate\(dispatch, message\.params\.arguments\)/u);
    assert.equal(old["runtime-isolation"].runtimeTask(f.store.db, f.context).generation, a.digest);
  });
});

async function seedResponsibility(f) {
  const dispatch = old["runtime-dispatch"].beginMcpDispatch("route_stage", { contextId: "owner" },
    { cwd: f.root, env: { CODEX_THREAD_ID: "owner" }, shellRoot: a.root });
  f.store.runtimeInvocation = dispatch.invocation;
  let route;
  try {
    route = await old.router.routeStage(helpers.routeInput({ contextId: "owner" }), {
      store: f.store, cwd: f.root, catalog: helpers.CATALOG, diskProbe: () => 20n * 1024n ** 3n,
    });
    assert.equal(route.action, "delegate");
  } finally { old["runtime-dispatch"].endRuntimeDispatch(dispatch); f.store.runtimeInvocation = null; }
  const childId = "epoch-child", taskName = route.carrier.taskName, agentPath = `/root/${taskName}`;
  const transcriptPath = join(f.root, "child.jsonl");
  writeFileSync(transcriptPath, JSON.stringify({ type: "session_meta", payload: { id: childId, session_id: "owner", parent_thread_id: "owner",
    cwd: f.root, agent_path: agentPath, source: { subagent: { thread_spawn: { parent_thread_id: "owner", depth: 1, agent_path: agentPath } } } } }) + "\n");
  const input = { task_name: taskName, message: route.carrier.message, model: route.target.model,
    reasoning_effort: route.target.effort, fork_turns: "none" };
  const message = { tool_name: "send_message", turn_id: "turn-a", tool_use_id: "accepted-input",
    tool_input: { target: childId, message: "Preserve this pending business requirement across the upgrade." } };
  f.store.transaction(() => {
    assert.equal(old["delegation-gate"].consumeDelegationTicket(f.store.db, f.context,
      { taskName, turnId: "turn-a", toolUseId: "spawn", toolInput: input }).allowed, true);
    assert.equal(old["delegation-gate"].claimDelegationSubagent(f.store.db, f.context,
      { taskName, agentId: childId, model: route.target.model }).allowed, true);
    old["delegation-gate"].observeAgentResult(f.store.db, f.context,
      { turnId: "turn-a", toolUseId: "spawn", toolInput: input, toolResponse: { agent_id: childId } });
    old["stage-closure"].registerManagedChild(f.store.db, f.context, route.routeId,
      { taskName, childId, parentContextId: "owner", agentPath, transcriptPath });
    assert.equal(old["stage-closure"].observeManagedMessage(f.store.db, f.context, message).allowed, true);
    assert.equal(old["stage-closure"].observeManagedMessage(f.store.db, f.context,
      { ...message, tool_response: "" }, { post: true }).allowed, true);
    old["delegation-gate"].observeSubagentStop(f.store.db, f.context, taskName, childId, 4096,
      { turnId: "child-turn", lastAssistantMessage: "Original result remains pending verification." });
    old["stage-closure"].observeManagedStop(f.store.db, route.routeId,
      { turnId: "child-turn", lastAssistantMessage: "Original result remains pending verification." });
  });
  return { routeId: route.routeId, childId, taskName, transcriptPath, message };
}

const businessSnapshot = (db) => JSON.stringify(Object.fromEntries([
  "routes", "delegation_attempts", "delegation_children", "delegation_messages", "delegation_child_stops",
  "delegation_stage_journal", "delegation_maintenance", "outcomes",
].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));

function receiptTable(db) {
  // A test-only table with a deliberately non-production name. This demonstrates
  // additive storage and atomic SQLite primitives, not a trusted receipt reader.
  db.exec(`CREATE TABLE feasibility_epoch_receipts (
    id TEXT PRIMARY KEY, route_id TEXT NOT NULL, origin TEXT NOT NULL, executor TEXT NOT NULL,
    revision INTEGER NOT NULL, source_digest TEXT NOT NULL, record TEXT NOT NULL)`);
}

test("real A and current B RouterStore constructors preserve additive evidence and accepted-but-unconsumed work", async () => {
  await fixture(async (f) => {
    const stage = await seedResponsibility(f);
    const baseline = businessSnapshot(f.store.db);
    receiptTable(f.store.db);
    const originalReceipt = ' {"schema":2,"note":"raw bytes retained","responsibility":"accepted-input"} ';
    f.store.db.prepare("INSERT INTO feasibility_epoch_receipts VALUES(?,?,?,?,?,?,?)")
      .run("stored-evidence-only", stage.routeId, a.digest, b.digest, 1, hash(baseline), originalReceipt);
    for (const Store of [bStore, old.database.RouterStore, bStore, old.database.RouterStore]) {
      const reader = new Store({ path: f.store.path });
      try {
        assert.equal(businessSnapshot(reader.db), baseline);
        assert.equal(reader.db.prepare("SELECT record FROM feasibility_epoch_receipts").get().record, originalReceipt);
        assert.ok(old["runtime-isolation"].pendingRuntimeResponsibilities(reader.db, f.context).includes("message"));
        const locator = reader.db.prepare("SELECT locator FROM delegation_children WHERE route_id=?").get(stage.routeId).locator;
        assert.equal(JSON.parse(old["private-state"].openPrivateState(reader.db, locator)).childId, stage.childId);
        const model = Store === bStore ? "gpt-5.6-sol" : "gpt-6-astra";
        reader.observeHostModel(f.context, model, { detectChanges: false });
        assert.equal(f.store.hostModelState(f.context).currentModel, model, "actual A/B store writes remain readable by A");
      } finally { reader.close(); }
    }
    // A's forward-version branch also permits its actual writer when all old
    // columns remain. This alone does not qualify a new database/package version.
    f.store.db.exec("PRAGMA user_version=11");
    const forward = new old.database.RouterStore({ path: f.store.path });
    try {
      assert.equal(forward.forwardDatabaseVersion, 11);
      assert.equal(businessSnapshot(forward.db), baseline);
      forward.transaction(() => forward.db.prepare("INSERT INTO meta(key,value) VALUES('feasibility-forward-write','A')").run());
    } finally { forward.close(); }
    assert.equal(old["stage-closure"].observeManagedMessage(f.store.db, f.context, stage.message).allowed, false,
      "an accepted native call must not become permission to redeliver after reopening");
  });
});

test("old RouterStore initialization still mutates legacy-shaped pending rows; new proof cannot reuse their flags", async () => {
  await fixture(async (f) => {
    const stage = await seedResponsibility(f);
    // Deliberate unsafe legacy-shaped counterexample, not a valid outcome.
    f.store.db.prepare(`UPDATE delegation_attempts SET ticket_consumed=0,outcome_recorded=1,outcome_status='unknown',finalized_at=NULL,
      root_turn_id=NULL,tool_use_id=NULL,dispatch_input_digest=NULL WHERE route_id=?`)
      .run(stage.routeId);
    const reader = new old.database.RouterStore({ path: f.store.path });
    try {
      const row = reader.db.prepare("SELECT ticket_hash,context_package,ambiguous,finalized_at FROM delegation_attempts WHERE route_id=?").get(stage.routeId);
      assert.equal(row.ticket_hash, null);
      assert.equal(row.context_package, null);
      assert.equal(row.ambiguous, 1);
      assert.ok(row.finalized_at, "A's real constructor performs historical reconciliation");
      assert.equal(reader.db.prepare("SELECT status FROM delegation_messages WHERE route_id=?").get(stage.routeId).status, "accepted");
    } finally { reader.close(); }
  });
});

test("task-only switching misses old child, carrier, message and outcome dispatch; pending Pre receipts retain A", async () => {
  await fixture(async (f) => {
    const stage = await seedResponsibility(f);
    f.store.transaction(() => selectTask(f, b.digest));
    const dispatch = old["runtime-dispatch"];
    const inspectHook = (input) => {
      const call = dispatch.beginHookDispatch({ session_id: "owner", cwd: f.root, turn_id: "turn-a", ...input }, { shellRoot: a.root });
      try { assert.equal(call.selected.digest, a.digest); } finally { dispatch.endRuntimeDispatch(call); }
    };
    inspectHook({ hook_event_name: "SubagentStop", agent_id: stage.childId, agent_transcript_path: stage.transcriptPath });
    inspectHook({ hook_event_name: "PreToolUse", tool_input: { task_name: stage.taskName } });
    inspectHook({ hook_event_name: "PreToolUse", tool_name: "followup_task", tool_input: { target: stage.childId } });
    for (const name of ["record_outcome", "manage_stage"]) {
      const call = dispatch.beginMcpDispatch(name, { contextId: "owner", routeId: stage.routeId },
        { cwd: f.root, env: { CODEX_THREAD_ID: "owner" }, shellRoot: a.root });
      try { assert.equal(call.selected.digest, a.digest); } finally { dispatch.endRuntimeDispatch(call); }
    }
    f.store.transaction(() => selectTask(f, a.digest));
    const args = { contextId: "owner" };
    const pre = dispatch.beginHookDispatch({ hook_event_name: "PreToolUse", session_id: "owner", cwd: f.root,
      turn_id: "turn-a", tool_use_id: "read-call", tool_name: "mcp__adaptive_model_router__get_route_status", tool_input: args }, { shellRoot: a.root });
    dispatch.endRuntimeDispatch(pre);
    assert.ok(old["runtime-isolation"].pendingRuntimeResponsibilities(f.store.db, f.context).includes("pending_native_call"));
    f.store.transaction(() => selectTask(f, b.digest));
    const continued = dispatch.beginMcpDispatch("get_route_status", args, { cwd: f.root, env: {}, shellRoot: a.root });
    try {
      assert.equal(continued.selected.digest, a.digest, "receipt generation takes precedence over a new task default");
      assert.equal(f.store.db.prepare("SELECT state FROM runtime_call_receipts").get().state, "consumed");
      assert.equal(f.store.db.prepare("SELECT state FROM runtime_invocations WHERE id=?").get(continued.invocation.id).state, "active");
    } finally { dispatch.endRuntimeDispatch(continued, false); }
    f.store.db.prepare("UPDATE runtime_invocations SET pid=-1,created_at='2000-01-01T00:00:00Z' WHERE id=?").run(continued.invocation.id);
    assert.ok(old["runtime-isolation"].pendingRuntimeResponsibilities(f.store.db, f.context).includes("in_flight_or_unknown_call"));
    assert.throws(() => dispatch.beginMcpDispatch("get_route_status", args, { cwd: f.root, env: {}, shellRoot: a.root }), /caller binding is unproven/);
  });
});

test("SQLite receipt/binding commit rolls back together and old v2 admission serializes; this is not an epoch verifier", async () => {
  await fixture(async (f) => {
    const stage = await seedResponsibility(f);
    const original = businessSnapshot(f.store.db);
    receiptTable(f.store.db);
    const compareAndWrite = ({ expectedRevision = 1, crash = false } = {}) => {
      assert.equal(f.store.db.isTransaction, true);
      assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM runtime_invocations WHERE state!='completed'").get().n, 0,
        "entered old invocation must cancel the fixture commit");
      assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM runtime_call_receipts WHERE state='pending'").get().n, 0,
        "unconsumed Pre receipt must cancel the fixture commit");
      const changed = f.store.db.prepare(`UPDATE runtime_stages SET generation=? WHERE route_id=? AND generation=?
        AND EXISTS(SELECT 1 FROM delegation_children WHERE route_id=? AND revision=?)`)
        .run(b.digest, stage.routeId, a.digest, stage.routeId, expectedRevision);
      assert.equal(changed.changes, 1, "stale stage/message snapshot cancels the fixture commit");
      f.store.db.prepare("INSERT INTO feasibility_epoch_receipts VALUES(?,?,?,?,?,?,?)")
        .run("fixture-epoch-1", stage.routeId, a.digest, b.digest, expectedRevision, hash(original), original);
      selectTask(f, b.digest);
      if (crash) throw new Error("injected interruption before commit");
    };
    assert.throws(() => f.store.transaction(() => compareAndWrite({ expectedRevision: 0 })), /stale stage/);
    assert.throws(() => f.store.transaction(() => compareAndWrite({ crash: true })), /injected interruption/);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM feasibility_epoch_receipts").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(stage.routeId).generation, a.digest);
    assert.equal(old["runtime-isolation"].runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(businessSnapshot(f.store.db), original);

    const dispatch = old["runtime-dispatch"];
    const entered = dispatch.beginMcpDispatch("get_route_status", { contextId: "owner" },
      { cwd: f.root, env: { CODEX_THREAD_ID: "owner" }, shellRoot: a.root });
    try { assert.throws(() => f.store.transaction(() => compareAndWrite()), /entered old invocation/); }
    finally { dispatch.endRuntimeDispatch(entered); }
    const pre = dispatch.beginHookDispatch({ hook_event_name: "PreToolUse", session_id: "owner", cwd: f.root,
      turn_id: "turn-a", tool_use_id: "atomic-read", tool_name: "mcp__adaptive_model_router__get_route_status",
      tool_input: { contextId: "owner" } }, { shellRoot: a.root });
    dispatch.endRuntimeDispatch(pre);
    assert.throws(() => f.store.transaction(() => compareAndWrite()), /unconsumed Pre receipt/);
    const read = dispatch.beginMcpDispatch("get_route_status", { contextId: "owner" }, { cwd: f.root, env: {}, shellRoot: a.root });
    dispatch.endRuntimeDispatch(read);

    // This child is an ordinary isolated Node process running A, not a Codex
    // subagent. Its old dispatcher cannot participate until BEGIN IMMEDIATE ends.
    const script = `import {beginMcpDispatch,endRuntimeDispatch} from ${JSON.stringify(pathToFileURL(join(a.root, "scripts/lib/runtime-dispatch.mjs")).href)};
process.stdout.write("attempting\\n");
const call=beginMcpDispatch("manage_stage",{contextId:"owner",routeId:${JSON.stringify(stage.routeId)}},
  {cwd:${JSON.stringify(f.root)},env:{CODEX_THREAD_ID:"owner"},shellRoot:${JSON.stringify(a.root)}});
process.stdout.write(JSON.stringify({generation:call.selected.digest,id:call.invocation.id})+"\\n");
endRuntimeDispatch(call);`;
    f.store.db.exec("BEGIN IMMEDIATE");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script],
      { cwd: f.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr.on("data", (data) => { errors += data; });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    try {
      assert.equal((await iterator.next()).value, "attempting");
      compareAndWrite();
      f.store.db.exec("COMMIT");
      const admitted = JSON.parse((await iterator.next()).value);
      await exited;
      assert.equal(admitted.generation, b.digest);
      assert.equal(businessSnapshot(f.store.db), original, "no new route, ticket, message delivery or outcome");
      assert.equal(f.store.db.prepare("SELECT record FROM feasibility_epoch_receipts").get().record, original);
      assert.ok(old["runtime-isolation"].pendingRuntimeResponsibilities(f.store.db, f.context).includes("message"));
      assert.throws(() => f.store.transaction(() => f.store.db.prepare("INSERT INTO feasibility_epoch_receipts SELECT * FROM feasibility_epoch_receipts").run()), /UNIQUE/);
    } finally {
      clearTimeout(timeout);
      if (f.store.db.isTransaction) f.store.db.exec("ROLLBACK");
      lines.close();
      if (child.exitCode === null) child.kill();
    }
  });
});

test("a direct frozen Hook writes without a v2 invocation: native entry retirement/reload is an unsolved v1 boundary", async () => {
  await fixture(async (f) => {
    f.store.transaction(() => selectTask(f, b.digest));
    const before = f.store.db.prepare("SELECT count(*) AS n FROM runtime_invocations").get().n;
    const result = hook(f, { model: "gpt-5.6-sol" }, { direct: true });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /EPOCH_PROBE_B_HOOK/u);
    assert.equal(f.store.hostModelState(f.context).currentModel, "gpt-5.6-sol");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM runtime_invocations").get().n, before);
    assert.equal(old["runtime-isolation"].runtimeTask(f.store.db, f.context).generation, b.digest);
    // This is the actual direct entry path in frozen A, not a fabricated v1
    // package. It proves why an unleased old Hook cannot be made safe just by
    // changing registry bindings. It provides no evidence that any real v1 task
    // has reloaded or that the host can retire its old entry while it is alive.
  });
});
