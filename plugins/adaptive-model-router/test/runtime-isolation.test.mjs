import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { RouterStore } from "../scripts/lib/database.mjs";
import { inspectRuntimePackage, prepareRuntimeCandidate } from "../scripts/lib/runtime-package.mjs";
import { qualifyRuntimeCompatibility } from "../scripts/lib/runtime-compatibility.mjs";
import { beginHookDispatch, beginMcpDispatch, endRuntimeDispatch } from "../scripts/lib/runtime-dispatch.mjs";
import { inspectRuntimeBoundary, isRuntimeBoundaryProof } from "../scripts/lib/runtime-boundary.mjs";
import { inspectColdRuntimeTransition } from "../scripts/lib/runtime-cold-transition.mjs";
import { acquireRuntimeInvocation, archiveRuntime, beginRuntimeMigration, ensureRuntimeTask, finishRuntimeInvocation,
  pendingRuntimeResponsibilities, publishRuntime, publishedDefault, runtimeGeneration, runtimeReferences, runtimeTask,
  settleRuntimeMigration } from "../scripts/lib/runtime-isolation.mjs";
import { resolveRuntime } from "../scripts/lib/runtime-loader.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { consumeDelegationTicket, claimDelegationSubagent, observeAgentResult, observeSubagentStop } from "../scripts/lib/delegation-gate.mjs";
import { registerManagedChild, observeManagedMessage } from "../scripts/lib/stage-closure.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment, completeNoChildRoute } from "./fixtures.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (root, name) => import(pathToFileURL(join(root, "scripts/lib", `${name}.mjs`)).href);
const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const call = (id, name, args) => ({ type: "response_item", payload: { type: "function_call", namespace: "functions", call_id: id, name, arguments: JSON.stringify(args) } });
const output = (id, text) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: text } });

test("trusted unmarked native children bypass every Hook without borrowing Router state; malformed carriers still deny", async () => {
  const project = await temporaryProject("router-unmanaged-child-");
  try {
    await withRouterEnvironment(project, async () => {
      const transcript = join(project.root, "child.jsonl");
      const identity = (taskName) => {
        const agentPath = `/root/${taskName}`;
        writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: "ordinary-child", session_id: "ordinary-parent", parent_thread_id: "ordinary-parent",
          cwd: project.root, agent_path: agentPath, source: { subagent: { thread_spawn: { parent_thread_id: "ordinary-parent", depth: 1, agent_path: agentPath } } } } }) + "\n");
      };
      identity("user_requested_reviewer");
      const base = { session_id: "ordinary-parent", agent_id: "ordinary-child", agent_type: "default", cwd: project.root, transcript_path: transcript };
      for (const [eventName, mode] of [["SubagentStart", "subagent-start"], ["PreToolUse", "pre-tool-use"], ["PostToolUse", "post-tool-use"], ["SubagentStop", "subagent-stop"]]) {
        const input = { ...base, hook_event_name: eventName, tool_name: "Bash", tool_input: { command: "printf ordinary-child" }, tool_response: { exit_code: 0 } };
        if (eventName === "SubagentStop") { input.agent_transcript_path = transcript; delete input.transcript_path; }
        assert.deepEqual(beginHookDispatch(input), { unmanaged: true });
        const result = spawnSync(process.execPath, [join(source, "scripts/node-launcher.mjs"), join(source, "scripts/hook.mjs"), mode], { env: process.env, cwd: project.root, input: JSON.stringify(input), encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
      }
      assert.equal(existsSync(project.home), false, "ordinary native children never initialize Router state");
      const command = spawnSync(process.execPath, ["-e", "process.stdout.write('ordinary-child')"], { env: process.env, cwd: project.root, encoding: "utf8" });
      assert.equal(command.status, 0); assert.equal(command.stdout, "ordinary-child");
      assert.throws(() => beginHookDispatch({ ...base, session_id: "forged-parent" }), /identity/);
      identity("router_0123456789abcdef0123456789abcdef");
      const denied = spawnSync(process.execPath, [join(source, "scripts/node-launcher.mjs"), join(source, "scripts/hook.mjs"), "pre-tool-use"], {
        env: process.env, cwd: project.root, input: JSON.stringify({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash" }), encoding: "utf8" });
      assert.equal(denied.status, 2); assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    });
  } finally { await project.cleanup(); }
});

function packageAt(root, version, { scorer = false, hook = false, writer = false } = {}) {
  cpSync(source, root, { recursive: true });
  for (const relative of ["runtime.json", ".codex-plugin/plugin.json"]) {
    const path = join(root, relative), json = JSON.parse(readFileSync(path, "utf8"));
    json[relative === "runtime.json" ? "runtimeVersion" : "version"] = version;
    writeFileSync(path, JSON.stringify(json));
  }
  if (scorer) {
    const path = join(root, "scripts/lib/scorer.mjs");
    writeFileSync(path, readFileSync(path, "utf8").replace('  if (includesAny(text, PATTERNS.review))', '  if (text.includes("glossary")) return "documentation";\n  if (includesAny(text, PATTERNS.review))'));
  }
  if (hook) writeFileSync(join(root, "scripts/hook.mjs"), readFileSync(join(root, "scripts/hook.mjs"), "utf8") + "\n// candidate lifecycle adapter revision\n");
  if (writer) writeFileSync(join(root, "scripts/lib/database.mjs"), readFileSync(join(root, "scripts/lib/database.mjs"), "utf8") + "\n// unqualified writer revision\n");
  return inspectRuntimePackage(root);
}

async function fixture(run) {
  const project = await temporaryProject("router-runtime-isolation-");
  try {
    await withRouterEnvironment(project, async () => {
      const a = packageAt(join(project.root, "shell-a"), "0.4.0+isolation.1");
      const b = packageAt(join(project.root, "candidate-b"), "0.4.0+isolation.2", { scorer: true });
      const store = new RouterStore();
      try {
        store.transaction(() => publishRuntime(store.db, a, project.home, { bootstrap: true, shellRoot: a.root }));
        const bind = (id, turn = "turn-a") => {
          const context = store.context({ cwd: project.root, contextId: id, authoritative: true });
          store.transaction(() => ensureRuntimeTask(store.db, context, { trustedHook: true, turnId: turn }));
          return context;
        };
        const publish = (candidate) => {
          const baseline = runtimeGeneration(store.db, publishedDefault(store.db).current_digest);
          const compatibilityProof = qualifyRuntimeCompatibility(baseline, candidate);
          return store.transaction(() => publishRuntime(store.db, candidate, project.home, { compatibilityProof }));
        };
        await run({ project, store, a, b, bind, publish });
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}

function rootTranscript(project, id, records) {
  const path = join(project.root, `${id}.jsonl`);
  writeFileSync(path, [{ type: "session_meta", payload: { id, cwd: project.root } }, ...records].map(JSON.stringify).join("\n") + "\n");
  return path;
}

test("uninitialized or damaged Router runtime does not deny ordinary root tools or invent command coverage", async () => {
  const project = await temporaryProject("router-root-repair-");
  try {
    await withRouterEnvironment(project, async () => {
      const launch = (root, toolInput, toolName = "Bash") => spawnSync(process.execPath,
        [join(root, "scripts/node-launcher.mjs"), join(root, "scripts/hook.mjs"), "pre-tool-use"], { env: process.env, cwd: project.root, encoding: "utf8",
          input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "root", turn_id: "repair-turn", tool_use_id: "repair-call", cwd: project.root, tool_name: toolName, tool_input: toolInput }) });
      const ordinary = launch(source, { command: "printf repair" });
      assert.equal(ordinary.status, 0, ordinary.stderr); assert.equal(ordinary.stdout, ""); assert.match(ordinary.stderr, /runtime_coverage_gap/);
      assert.equal(existsSync(project.home), false);
      const carrier = { task_name: "router_0123456789abcdef0123456789abcdef" };
      assert.equal(JSON.parse(launch(source, carrier, "spawn_agent").stdout).hookSpecificOutput.permissionDecision, "deny");
      assert.equal(existsSync(project.home), false);
      const a = packageAt(join(project.root, "registered"), "0.4.0+repair-fixture");
      const store = new RouterStore();
      try {
        store.transaction(() => publishRuntime(store.db, a, project.home, { bootstrap: true, shellRoot: a.root }));
        writeFileSync(join(a.root, "runtime.json"), "broken-json");
        const repair = launch(a.root, { command: "printf repair" });
        assert.equal(repair.status, 0, repair.stderr); assert.equal(repair.stdout, ""); assert.match(repair.stderr, /runtime_coverage_gap/);
        assert.equal(JSON.parse(launch(a.root, carrier, "spawn_agent").stdout).hookSpecificOutput.permissionDecision, "deny");
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM runtime_root_commands").get().n, 0);
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM runtime_invocations").get().n, 0);
        writeFileSync(join(a.root, "scripts/lib/runtime-dispatch.mjs"), "syntactically broken module !");
        const brokenAdapter = launch(a.root, { command: "printf repair" });
        assert.equal(brokenAdapter.status, 0, brokenAdapter.stderr); assert.match(brokenAdapter.stderr, /runtime_coverage_gap/);
        assert.equal(JSON.parse(launch(a.root, carrier, "spawn_agent").stdout).hookSpecificOutput.permissionDecision, "deny");
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});
function boundary(project, id, previousTurn = "turn-a", nextTurn = "turn-b", extra = []) {
  const path = rootTranscript(project, id, [event("task_started", { turn_id: previousTurn }), ...extra, event("task_complete", { turn_id: previousTurn })]);
  return inspectRuntimeBoundary({ hook_event_name: "UserPromptSubmit", session_id: id, turn_id: nextTurn, transcript_path: path }, previousTurn);
}

function rpc(root, project, contextId) {
  const child = spawn(process.execPath, [join(root, "scripts/mcp-server.mjs")], { cwd: project.root,
    env: { ...process.env, CODEX_HOME: join(project.root, "codex"), CODEX_THREAD_ID: contextId }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map(); let sequence = 0;
  let errors = ""; child.stderr.on("data", (chunk) => { errors += chunk; });
  lines.on("line", (line) => { const result = JSON.parse(line); waiting.get(result.id)?.(result); waiting.delete(result.id); });
  return {
    async call(name, args = { contextId }) {
      const id = ++sequence;
      const response = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
      return response;
    },
    async close() { child.stdin.end(); if (child.exitCode === null) await new Promise((done) => child.once("exit", done)); assert.equal(child.exitCode, 0, errors); },
  };
}

async function qualifyFixture(f, id, { fail = false, omitStop = false } = {}) {
  const dispatch = beginMcpDispatch("route_stage", { contextId: id }, { cwd: f.project.root, env: { CODEX_THREAD_ID: id } });
  const [service, qualification, gate, router] = await Promise.all(["service", "lifecycle-qualification", "delegation-gate", "router"].map((name) => mod(dispatch.selected.root, name)));
  const store = service.createServiceStore({ runtimeInvocation: dispatch.invocation });
  try {
    const context = store.context({ cwd: f.project.root, contextId: id });
    const binding = { runtimeDigest: qualification.runtimeSourceDigest(), configurationDigest: payloadHash("fixture host/hook chain"),
      taskCwdDigest: payloadHash(realpathSync(f.project.root)), shellRoots: [payloadHash(realpathSync(f.a.root))], cliVersion: "0.153.0" };
    binding.digest = payloadHash(binding);
    const readiness = () => qualification.qualificationReadiness(store.db, context, binding);
    if (readiness().ready) return { context, binding, qualified: qualification.verifiedRuntimeQualification(store.db, context) };
    const route = await router.routeStage(routeInput({ contextId: id }), { store, cwd: f.project.root, catalog: CATALOG,
      diskProbe: () => 20n * 1024n ** 3n, lifecycleHookProbe: async () => readiness() });
    assert.deepEqual(route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    const childId = `child-${route.routeId}`, turnId = `root-${route.routeId}`, toolUseId = `call-${route.routeId}`, childTurn = "child-turn";
    const taskName = route.carrier.taskName, agentPath = `/root/${taskName}`, marker = qualification.readTaskQualification(store.db, context).marker;
    const toolInput = { task_name: taskName, message: route.carrier.message, model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
    store.transaction(() => {
      gate.consumeDelegationTicket(store.db, context, { taskName, turnId, toolUseId, toolInput });
      gate.claimDelegationSubagent(store.db, context, { taskName, agentId: childId, model: route.target.model });
      gate.observeAgentResult(store.db, context, { turnId, toolUseId, toolInput, toolResponse: { agent_id: childId } });
      if (!omitStop) gate.observeSubagentStop(store.db, context, taskName, childId, 4096);
      for (const event of ["pre", "start", "post", ...(omitStop ? [] : ["stop"])]) qualification.observeQualificationHook(store.db, context, route.routeId, event, f.a.root);
    });
    const parent = { id, cwd: f.project.root, turns: [{ id: turnId, itemsView: "full", items: [
      { type: "subAgentActivity", kind: "started", id: toolUseId, agentThreadId: childId, agentPath },
      { type: "subAgentActivity", kind: "completed", id: `subagent-completed-${childTurn}`, agentThreadId: childId, agentPath }] }] };
    const child = { id: childId, parentThreadId: id, forkedFromId: null, cwd: f.project.root, cliVersion: binding.cliVersion,
      model: route.target.model, reasoningEffort: route.target.effort, path: "/fixture-native/child.jsonl",
      source: { subAgent: { thread_spawn: { parent_thread_id: id, depth: 1, agent_path: agentPath } } },
      turns: [{ id: childTurn, status: "completed", error: null, itemsView: "full", items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: marker }] }] };
    const records = [{ type: "session_meta", payload: { id: childId, parent_thread_id: id, cli_version: binding.cliVersion } },
      event("task_started", { turn_id: childTurn }), { type: "turn_context", payload: { turn_id: childTurn, model: route.target.model, effort: route.target.effort } },
      { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } }, event("task_complete", { turn_id: childTurn })];
    const outcome = { contextId: id, routeId: route.routeId, status: "passed", gate: route.verificationGate, failureType: null, retries: 0,
      retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false };
    const options = { store, cwd: f.project.root, qualificationOptions: { inspectBinding: async () => ({ binding }),
      readNative: async () => ({ parent, child }), auditOptions: { readTranscript: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n") } } };
    if (fail || omitStop) {
      records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec" } });
      await assert.rejects(service.callRouterTool("record_outcome", outcome, options), /verification failed/);
      await service.callRouterTool("record_outcome", { ...outcome, status: "failed", failureType: "tooling" }, options);
    } else await service.callRouterTool("record_outcome", outcome, options);
    return { context, binding, qualified: qualification.verifiedRuntimeQualification(store.db, context),
      state: qualification.readTaskQualification(store.db, context), route, childId, taskName };
  } finally { store.close(); endRuntimeDispatch(dispatch); }
}

test("a verified ordinary code update reuses unchanged lifecycle capability in a separate candidate record and migrates only at the native boundary", async () => {
  await fixture(async (f) => {
    const context = f.bind("qualified");
    const original = await qualifyFixture(f, "qualified");
    assert.equal(original.qualified.state, "passed");
    const originalJson = JSON.stringify(original.qualified);
    f.publish(f.b);
    assert.equal(runtimeTask(f.store.db, context).generation, f.a.digest);
    assert.equal(f.store.transaction(() => beginRuntimeMigration(f.store.db, context, { previousTurn: "turn-a", nextTurn: "fake", digest: "claimed" })), false);
    assert.equal(f.store.transaction(() => beginRuntimeMigration(f.store.db, context, boundary(f.project, "qualified"))), true);
    const candidate = await qualifyFixture(f, "qualified");
    assert.equal(candidate.qualified.inheritedFromRuntime, f.a.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1, "unchanged adapter does not spawn another native self-test");
    const settled = f.store.transaction(() => settleRuntimeMigration(f.store.db, context, { candidateQualification: candidate.qualified, candidateReady: true }));
    assert.equal(settled.state, "migrated");
    const old = (await mod(f.a.root, "lifecycle-qualification")).readTaskQualification(f.store.db, original.context);
    assert.equal(JSON.stringify(old), originalJson);
    assert.equal(runtimeTask(f.store.db, context).generation, f.b.digest);
  });
});

test("candidate failed proof remains separate from still-valid A and missing Stop never opens admission", async () => {
  await fixture(async (f) => {
    const contexts = new Map();
    for (const id of ["failed", "unknown"]) { contexts.set(id, f.bind(id)); await qualifyFixture(f, id); }
    f.publish(f.b);
    for (const id of ["failed", "unknown"]) {
      const context = contexts.get(id);
      assert.equal(f.store.transaction(() => beginRuntimeMigration(f.store.db, context, boundary(f.project, id))), true);
      // Deliberately require a fresh candidate qualification in this isolated
      // lifecycle fixture: retain the old proof but change the candidate host
      // binding. No production API accepts this fixture mutation.
      const oldKey = `native_qualification:${context.projectId}:${context.contextKey}:runtime:${f.a.digest}`;
      const saved = f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(oldKey).value;
      const old = JSON.parse(saved); old.binding.digest = "f".repeat(64);
      f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(old), oldKey);
      const candidate = await qualifyFixture(f, id, { fail: true, omitStop: id === "unknown" });
      f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(saved, oldKey);
      const settled = f.store.transaction(() => settleRuntimeMigration(f.store.db, context, {
        candidateQualification: candidate.qualified, oldQualificationValid: true }));
      assert.equal(settled.state, id === "failed" ? "restored" : "blocked");
      assert.equal(runtimeTask(f.store.db, context).generation, f.a.digest);
      assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(oldKey).value, saved);
      assert.equal(candidate.state.state, "failed");
    }
  });
});

test("explicitly qualified code publication isolates two long-lived MCP processes and Hook snapshots", async () => {
  await fixture(async ({ project, store, a, b, bind, publish }) => {
    bind("old-task");
    const old = rpc(a.root, project, "old-task"), fresh = rpc(a.root, project, "new-task");
    try {
      assert.equal((await old.call("diagnose_router")).result.structuredContent.runtime.contentDigest, a.digest);
      assert.equal((await fresh.call("diagnose_router")).result.isError, true, "caller args cannot establish task authority");
      const shellBefore = inspectRuntimePackage(a.root).digest;
      const prepared = prepareRuntimeCandidate(b.root, join(project.root, "offline-candidates"));
      assert.equal(resolveRuntime(a.root).candidate.root, a.root);
      assert.equal(publishedDefault(store.db).current_digest, a.digest, "preparation is never publication");
      publish(prepared);
      assert.equal(inspectRuntimePackage(a.root).digest, shellBefore, "publication did not rewrite historical shell files");
      bind("new-task");
      assert.equal((await old.call("diagnose_router")).result.structuredContent.runtime.contentDigest, a.digest);
      assert.equal((await fresh.call("diagnose_router")).result.structuredContent.runtime.contentDigest, b.digest);
      assert.equal((await mod(a.root, "scorer")).inferCategory("glossary"), "general");
      assert.equal((await mod(b.root, "scorer")).inferCategory("glossary"), "documentation", "B contains a real executed code change");
      for (const [id, version] of [["old-task", a.descriptor.runtimeVersion], ["new-task", b.descriptor.runtimeVersion]]) {
        const result = spawnSync(process.execPath, [join(a.root, "scripts/node-launcher.mjs"), join(a.root, "scripts/hook.mjs"), "session-start"], {
          env: { ...process.env, PLUGIN_ROOT: a.root, ADAPTIVE_ROUTER_RUNTIME_TRACE: "1" }, cwd: project.root, encoding: "utf8",
          input: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: project.root, source: "resume" }) });
        assert.equal(result.status, 0, result.stderr); assert.ok(result.stderr.includes(`runtime=${version}`));
      }
    } finally { await Promise.all([old.close(), fresh.close()]); }
  });
});

test("admission-before-spawn pins ticket, trusted child, message and result to A after B publication", async () => {
  await fixture(async ({ project, store, a, b, bind, publish }) => {
    const context = bind("owner");
    const dispatch = beginMcpDispatch("route_stage", { contextId: "owner" }, { env: { CODEX_THREAD_ID: "owner" }, cwd: project.root });
    store.runtimeInvocation = dispatch.invocation;
    const route = await routeStage(routeInput({ contextId: "owner" }), { store, cwd: project.root, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
    assert.equal(route.action, "delegate");
    endRuntimeDispatch(dispatch);
    publish(b);
    assert.equal(store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(route.routeId).generation, a.digest);
    assert.equal(store.transaction(() => beginRuntimeMigration(store.db, context, boundary(project, "owner"))), false);
    const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message, model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
    const pre = beginHookDispatch({ hook_event_name: "PreToolUse", session_id: "owner", cwd: project.root, turn_id: "turn-a", tool_use_id: "spawn", tool_input: toolInput });
    assert.equal(pre.selected.digest, a.digest); endRuntimeDispatch(pre);
    store.transaction(() => consumeDelegationTicket(store.db, context, { taskName: route.carrier.taskName, turnId: "turn-a", toolUseId: "spawn", toolInput }));
    const childId = "native-child", agentPath = `/root/${route.carrier.taskName}`, transcriptPath = join(project.root, "child.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "session_meta", payload: { id: childId, session_id: "owner", parent_thread_id: "owner", cwd: project.root, agent_path: agentPath,
      source: { subagent: { thread_spawn: { parent_thread_id: "owner", depth: 1, agent_path: agentPath } } } } }) + "\n");
    const childHook = { hook_event_name: "SubagentStart", session_id: "owner", cwd: project.root, agent_id: childId, transcript_path: transcriptPath };
    const child = beginHookDispatch(childHook); assert.equal(child.selected.digest, a.digest); endRuntimeDispatch(child);
    assert.throws(() => beginHookDispatch({ ...childHook, session_id: "forged-parent" }), /identity/);
    store.transaction(() => {
      claimDelegationSubagent(store.db, context, { taskName: route.carrier.taskName, agentId: childId, model: route.target.model });
      observeAgentResult(store.db, context, { turnId: "turn-a", toolUseId: "spawn", toolInput, toolResponse: { agent_id: childId } });
      registerManagedChild(store.db, context, route.routeId, { taskName: route.carrier.taskName, childId, parentContextId: "owner", agentPath, transcriptPath });
    });
    const message = beginHookDispatch({ hook_event_name: "PreToolUse", session_id: "owner", cwd: project.root, tool_name: "followup_task", tool_input: { target: childId }, turn_id: "turn-a", tool_use_id: "follow" });
    assert.equal(message.selected.digest, a.digest); endRuntimeDispatch(message);
    const result = beginMcpDispatch("record_outcome", { contextId: "owner", routeId: route.routeId }, { env: { CODEX_THREAD_ID: "owner" }, cwd: project.root });
    assert.equal(result.selected.digest, a.digest); endRuntimeDispatch(result);
    assert.ok(pendingRuntimeResponsibilities(store.db, context).includes("unfinished_stage"));
    assert.ok(runtimeReferences(store.db, a.digest).includes("active_stage"));
  });
});

test("native boundary carries root process/cell responsibility across intermediate turns and recognizes exact terminal polls", async () => {
  const project = await temporaryProject("router-boundary-");
  try {
    const records = [event("task_started", { turn_id: "n" }), call("start", "exec_command", { cmd: "long-job" }),
      output("start", "Chunk ID: one\nProcess running with session ID 17\nOutput:\n"), event("task_complete", { turn_id: "n" }),
      event("task_started", { turn_id: "n1" }), event("task_complete", { turn_id: "n1" })];
    let path = rootTranscript(project, "owner", records);
    const inspect = () => inspectRuntimeBoundary({ hook_event_name: "UserPromptSubmit", session_id: "owner", turn_id: "n2", transcript_path: path }, "n1");
    assert.equal(inspect(), null, "N+1 completion cannot forget N's process");
    records.splice(-1, 0, call("poll", "write_stdin", { session_id: 17 }), output("poll", "Chunk ID: two\nProcess exited with code 0\nOutput:\n"));
    path = rootTranscript(project, "owner", records); assert.ok(inspect());
    assert.equal(inspectRuntimeBoundary({ hook_event_name: "Stop", session_id: "owner", turn_id: "n1", transcript_path: path }, "n1"), null);
    records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", call_id: "cell", name: "exec", input: "text(await tools.exec_command({cmd:'job'}));" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cell", output: "Script running with cell ID opaque-cell\n" } });
    rootTranscript(project, "owner", records); assert.equal(inspect(), null);
  } finally { await project.cleanup(); }
});

test("invocation leases stop migration and GC; a crashed/stale lease is never expired into success", async () => {
  await fixture(async ({ project, store, a, b, bind, publish }) => {
    const context = bind("owner"); publish(b);
    const current = store.transaction(() => acquireRuntimeInvocation(store.db, context, { kind: "mcp:route_stage" }));
    const proof = boundary(project, "owner");
    assert.equal(store.transaction(() => beginRuntimeMigration(store.db, context, proof)), false);
    store.db.prepare("UPDATE runtime_invocations SET created_at='1970-01-01',pid=2147483647 WHERE id=?").run(current.invocation.id);
    assert.equal(store.transaction(() => beginRuntimeMigration(store.db, context, proof)), false);
    store.transaction(() => finishRuntimeInvocation(store.db, current.invocation, { completed: false }));
    assert.ok(pendingRuntimeResponsibilities(store.db, context).includes("in_flight_or_unknown_call"));
    assert.throws(() => store.transaction(() => archiveRuntime(store.db, a.digest, project.home)), /referenced/);
  });
});

test("prospective native root receipts settle parallel command batches across turns without accepting opaque or missing work", async () => {
  await fixture(async ({ project, store, bind }) => {
    const context = bind("batch", "n");
    const records = [event("task_started", { turn_id: "n" })];
    const path = rootTranscript(project, "batch", records);
    const base = { session_id: "batch", cwd: project.root, transcript_path: path, turn_id: "n" };
    endRuntimeDispatch(beginHookDispatch({ ...base, hook_event_name: "UserPromptSubmit" }));
    const code = 'const results = await Promise.allSettled([tools.exec_command({cmd:"printf one"}), tools.exec_command({cmd:"printf two"})]); for (const item of results) text(item);';
    records.push({ type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "batch-call", input: code } });
    for (const [id, command] of [["inner-one", "printf one"], ["inner-two", "printf two"]]) {
      endRuntimeDispatch(beginHookDispatch({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command } }));
      records.push(event("item_started", { thread_id: "batch", turn_id: "n", item: { id, type: "CommandExecution", source: "unified_exec_startup", status: "in_progress" } }));
    }
    records.push({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "batch-call", output: "Script completed\n" } }, event("task_complete", { turn_id: "n" }),
      event("task_started", { turn_id: "n1" }), event("task_complete", { turn_id: "n1" }));
    rootTranscript(project, "batch", records);
    const inspect = () => inspectRuntimeBoundary({ ...base, hook_event_name: "UserPromptSubmit", turn_id: "n2" }, "n1", { db: store.db, context });
    assert.equal(inspect(), null, "outer completion and another completed turn cannot settle running inner commands");
    for (const [index, id, command] of [[0, "inner-one", "printf one"], [1, "inner-two", "printf two"]]) {
      endRuntimeDispatch(beginHookDispatch({ ...base, turn_id: "n1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id,
        tool_input: { command }, tool_response: "Process exited with code 0" }));
      records.splice(-1, 0, event("item_completed", { thread_id: "batch", turn_id: "n", item: { id, type: "CommandExecution", source: "unified_exec_startup", status: "completed", exit_code: 0 } }));
      rootTranscript(project, "batch", records);
      if (!index) assert.equal(inspect(), null, "one missing terminal keeps the other inner operation pending");
    }
    const proof = inspect(); assert.ok(proof);
    for (const forwarding of [
      code,
      'const rs=await Promise.allSettled([tools.exec_command({cmd:"printf one"}),tools.exec_command({cmd:"printf two"})]); for(let i=0;i<rs.length;i++)text({i,...rs[i]});',
      'const rs = await Promise.all([tools.exec_command({cmd:"printf one"}), tools.exec_command({cmd:"printf two"})]); rs.forEach((r,i)=>text({i,...r}));',
      'const rs = await Promise.allSettled([tools.exec_command({cmd:"printf one"}), tools.exec_command({cmd:"printf two"})]); rs.forEach(text);',
    ]) {
      for (const name of ["rs", "$", "$results", "results$", "re$sults"]) {
        const renamed = forwarding.replace(/\b(?:results|rs)\b/gu, () => name);
        records[1].payload.input = renamed; rootTranscript(project, "batch", records);
        assert.ok(inspect(), `literal identifier remains covered: ${renamed}`);
      }
    }
    for (const invalid of [
      code.replace("of results", "of results$"),
      code.replace("const results", "const results$"),
      code.replaceAll("results", String.raw`re\sults`),
      code.replaceAll("results", String.raw`\u0072esults`),
    ]) {
      records[1].payload.input = invalid; rootTranscript(project, "batch", records);
      assert.equal(inspect(), null, `unproven identifier cannot settle native work: ${invalid}`);
    }
    records[1].payload.input = code; rootTranscript(project, "batch", records);
    const currentProof = inspect(); assert.ok(currentProof);
    assert.equal(isRuntimeBoundaryProof(currentProof, store.db, context), true);
    store.db.prepare("UPDATE runtime_root_commands SET post_seen=0 WHERE call_id='inner-two'").run();
    assert.equal(isRuntimeBoundaryProof(currentProof, store.db, context), false, "changed receipts invalidate the preflight before the transaction");
    assert.equal(inspect(), null, "native transcript terminal alone cannot cover a missing required batch Hook receipt");
    store.db.prepare("UPDATE runtime_root_commands SET post_seen=1 WHERE call_id='inner-two'").run();
    records[1].payload.input = code + " await tools.start_external_job({});";
    rootTranscript(project, "batch", records);
    assert.equal(inspect(), null, "opaque external work has no authoritative coverage even if both known commands ended");
    records[1].payload.input = code;
    records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "status", input: 'text(await tools.mcp__adaptive_model_router__get_route_status({contextId:"batch"}));' } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "status", output: "Script completed\n" } });
    rootTranscript(project, "batch", records); const fresh = inspect(); assert.ok(fresh);
    records.push(event("task_started", { turn_id: "n2" })); rootTranscript(project, "batch", records);
    assert.equal(isRuntimeBoundaryProof(fresh, store.db, context), false, "changed native file invalidates the content-bound proof");
  });
});

test("large slow native boundary scans have a shared deadline and do not hold the shared SQLite writer lock", async () => {
  await fixture(async ({ project, store, bind }) => {
    const context = bind("slow", "n");
    const path = rootTranscript(project, "slow", [event("task_started", { turn_id: "n" }),
      ...Array.from({ length: 32768 }, () => event("agent_message", { message: "x".repeat(1000) })), event("task_complete", { turn_id: "n" })]);
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      import {beginHookDispatch,endRuntimeDispatch} from ${JSON.stringify(pathToFileURL(join(source, "scripts/lib/runtime-dispatch.mjs")).href)};
      const nativeRead=fs.readSync; let signaled=false;
      fs.readSync=function(fd,...args) { if(fs.fstatSync(fd).size>20000000) { if(!signaled){process.stdout.write('scanning\\n');signaled=true;}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80); } return nativeRead.call(fs,fd,...args); }; syncBuiltinESMExports();
      const started=Date.now(); endRuntimeDispatch(beginHookDispatch(${JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "slow", cwd: project.root, transcript_path: path, turn_id: "n1" })}));
      process.stdout.write(JSON.stringify({elapsed:Date.now()-started})+'\\n');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: project.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((done, reject) => { child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("scanning\n")) done(); }); child.once("error", reject); child.once("exit", () => { if (!stdout.includes("scanning\n")) reject(new Error(stderr)); }); });
    const started = Date.now();
    store.transaction(() => store.db.prepare("INSERT INTO meta(key,value) VALUES('independent_writer','completed')").run());
    assert.ok(Date.now() - started < 150, "another task can write while the native reader is deliberately slow");
    await new Promise((done) => child.once("exit", done)); assert.equal(child.exitCode, 0, stderr);
    assert.ok(JSON.parse(stdout.trim().split("\n").at(-1)).elapsed < 1500, "a shared scan budget aborts before reading the large transcript twice");
    assert.equal(runtimeTask(store.db, context).candidate, null);
  });
});

test("both trusted-environment and Hook-receipt MCP calls settle their exact native receipt; unknown rejection remains pending", async () => {
  await fixture(async ({ project, store, bind }) => {
    const context = bind("owner");
    const args = { contextId: "owner" };
    const hook = { hook_event_name: "PreToolUse", session_id: "owner", cwd: project.root, turn_id: "turn-a", tool_use_id: "call-1",
      tool_name: "mcp__adaptive_model_router__get_route_status", tool_input: args };
    for (const [i, env] of [{ CODEX_THREAD_ID: "owner" }, {}].entries()) {
      const pre = beginHookDispatch({ ...hook, tool_use_id: `call-${i}` }); endRuntimeDispatch(pre);
      const dispatch = beginMcpDispatch("get_route_status", args, { cwd: project.root, env }); endRuntimeDispatch(dispatch);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM runtime_call_receipts WHERE state='pending'").get().n, 0);
    }
    assert.throws(() => beginMcpDispatch("get_route_status", args, { cwd: project.root, env: {} }), /caller binding/);
    const unknown = beginHookDispatch({ ...hook, tool_use_id: "unknown" }); endRuntimeDispatch(unknown);
    const post = beginHookDispatch({ ...hook, tool_use_id: "unknown", hook_event_name: "PostToolUse", tool_response: { isError: true } }); endRuntimeDispatch(post);
    assert.ok(pendingRuntimeResponsibilities(store.db, context).includes("pending_native_call"));
    const rejected = beginHookDispatch({ ...hook, tool_use_id: "unknown", hook_event_name: "PostToolUse", tool_response: { error: { code: -32601 } } }); endRuntimeDispatch(rejected);
    assert.equal(pendingRuntimeResponsibilities(store.db, context).includes("pending_native_call"), false);
    for (let i = 0; i < 140; i++) { const dispatch = beginMcpDispatch("get_route_status", args, { cwd: project.root, env: { CODEX_THREAD_ID: "owner" } }); endRuntimeDispatch(dispatch); }
    assert.ok(store.db.prepare("SELECT count(*) AS n FROM runtime_invocations WHERE state='completed'").get().n <= 128);
  });
});

test("entrypoint redirection and entry code cannot bypass frozen compatibility, including the cold bridge", async () => {
  await fixture(async ({ project, a, b, store, publish }) => {
    const descriptorPath = join(b.root, "runtime.json");
    const original = JSON.parse(readFileSync(descriptorPath, "utf8"));
    const extra = "scripts/unqualified-entry.mjs", marker = join(project.root, "must-not-execute");
    writeFileSync(join(b.root, extra), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unqualified');`);
    const old = process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE ? inspectRuntimePackage(process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE, { legacy: true }) : null;
    for (const name of ["hook", "service", "probe"]) {
      writeFileSync(descriptorPath, JSON.stringify({ ...original, entrypoints: { ...original.entrypoints, [name]: extra } }));
      const redirected = inspectRuntimePackage(b.root);
      assert.notEqual(redirected.writerDigest, a.writerDigest);
      assert.notEqual(redirected.shellDigest, a.shellDigest);
      assert.throws(() => publish(redirected), /entrypoint mapping/);
      if (old) assert.throws(() => qualifyRuntimeCompatibility(old, redirected, { coldLegacy: true }), /entrypoint mapping/);
      assert.equal(publishedDefault(store.db).current_digest, a.digest);
      assert.equal(existsSync(marker), false, "rejected candidate entrypoints never execute");
    }
    // Formatting/key order and the release name do not change dispatch; entry
    // code at an unchanged path still does, including the non-lib probe.
    writeFileSync(descriptorPath, JSON.stringify({ ...original, entrypoints: { probe: original.entrypoints.probe, service: original.entrypoints.service, hook: original.entrypoints.hook } }));
    const reordered = inspectRuntimePackage(b.root);
    assert.equal(reordered.writerDigest, a.writerDigest);
    assert.equal(reordered.shellDigest, a.shellDigest);
    writeFileSync(join(b.root, original.entrypoints.probe), readFileSync(join(b.root, original.entrypoints.probe), "utf8") + "\n// changed probe entry\n");
    assert.throws(() => publish(inspectRuntimePackage(b.root)), /Unproven writer\/shell/);
  });
});

test("full digests reject tampering, shell/writer changes, self-asserted compatibility and symlink candidate aliases", async () => {
  await fixture(async ({ project, store, a, b }) => {
    assert.throws(() => store.transaction(() => publishRuntime(store.db, b, project.home, { compatibilityProof: { source: a.digest, candidate: b.digest } })), /qualification/);
    const writer = packageAt(join(project.root, "writer-change"), "0.4.0+isolation.writer", { writer: true });
    assert.throws(() => qualifyRuntimeCompatibility(a, writer), /Unproven/);
    const cache = join(project.root, "cache"); mkdirSync(cache);
    symlinkSync(cache, join(project.root, "innocent-name"), "dir");
    assert.throws(() => prepareRuntimeCandidate(b.root, join(project.root, "innocent-name", "candidates")), /discovery/);
    const published = runtimeGeneration(store.db, a.digest);
    writeFileSync(join(published.root, "README.md"), "damaged non-executable content");
    const context = store.context({ cwd: project.root, contextId: "tamper" });
    store.transaction(() => ensureRuntimeTask(store.db, context, { trustedHook: true }));
    assert.throws(() => store.transaction(() => acquireRuntimeInvocation(store.db, context, { kind: "read" })), /integrity/);
  });
});

test("cold bootstrap preserves finalized legacy history and refuses active/unknown history or a live host", async () => {
  const project = await temporaryProject("router-cold-history-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const route = await routeStage(routeInput(), { store, cwd: project.root, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
        assert.throws(() => inspectColdRuntimeTransition(store.db, { inventory: () => [] }), /unfinished/);
        completeNoChildRoute(route, { store, cwd: project.root, contextId: "test-context", status: "failed", failureType: "tooling" });
        const before = JSON.stringify(store.db.prepare("SELECT * FROM outcomes").all());
        const candidate = packageAt(join(project.root, "shell"), "0.4.0+cold");
        assert.throws(() => store.transaction(() => publishRuntime(store.db, candidate, project.home, { bootstrap: true, shellRoot: candidate.root })), /cold host/);
        assert.throws(() => inspectColdRuntimeTransition(store.db, { inventory: () => [{ pid: 1, executable: "/Applications/Codex.app/Contents/MacOS/Codex" }] }), /stopped/);
        store.transaction(() => publishRuntime(store.db, candidate, project.home, { bootstrap: true, shellRoot: candidate.root,
          coldProof: inspectColdRuntimeTransition(store.db, { inventory: () => [] }) }));
        assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM outcomes").all()), before);
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});

test("settled historical stages can be archived and restored for their owning generation, including rename/commit crashes", async () => {
  await fixture(async (f) => {
    f.publish(f.b);
    const context = f.bind("dormant");
    const old = await qualifyFixture(f, "dormant");
    const c = packageAt(join(f.project.root, "candidate-c"), "0.4.0+isolation.3", { scorer: true });
    const d = packageAt(join(f.project.root, "candidate-d"), "0.4.0+isolation.4", { scorer: true });
    f.publish(c); f.publish(d);
    assert.throws(() => f.store.transaction(() => archiveRuntime(f.store.db, f.b.digest, f.project.home)), /task/);
    assert.equal(f.store.transaction(() => beginRuntimeMigration(f.store.db, context, boundary(f.project, "dormant"))), true);
    const candidate = await qualifyFixture(f, "dormant");
    assert.equal(f.store.transaction(() => settleRuntimeMigration(f.store.db, context, { candidateQualification: candidate.qualified, candidateReady: true })).state, "migrated");
    assert.deepEqual(runtimeReferences(f.store.db, f.b.digest), []);
    assert.throws(() => f.store.transaction(() => { archiveRuntime(f.store.db, f.b.digest, f.project.home); throw new Error("crash after rename"); }), /crash/);
    assert.equal(runtimeGeneration(f.store.db, f.b.digest).digest, f.b.digest, "recover exact retained digest after DB rollback");
    f.store.transaction(() => archiveRuntime(f.store.db, f.b.digest, f.project.home));
    assert.equal(runtimeGeneration(f.store.db, f.b.digest).state, "archived");
    const historical = beginMcpDispatch("record_outcome", { contextId: "dormant", routeId: old.qualified.routeId }, { cwd: f.project.root, env: { CODEX_THREAD_ID: "dormant" } });
    assert.equal(historical.selected.digest, f.b.digest);
    assert.equal(runtimeGeneration(f.store.db, f.b.digest).state, "published");
    assert.ok(runtimeGeneration(f.store.db, f.b.digest).root.startsWith(realpathSync(f.project.home) + "/"), "partial caller identity env cannot move a package outside the database home");
    endRuntimeDispatch(historical);
    f.store.transaction(() => archiveRuntime(f.store.db, f.b.digest, f.project.home));
    const conflictingHome = join(f.project.root, "must-not-become-another-domain");
    const conflicting = beginMcpDispatch("record_outcome", { contextId: "dormant", routeId: old.qualified.routeId }, { cwd: f.project.root,
      env: { CODEX_THREAD_ID: "dormant", ADAPTIVE_ROUTER_HOME: conflictingHome } });
    assert.ok(conflicting.selected.root.startsWith(realpathSync(f.project.home) + "/")); endRuntimeDispatch(conflicting);
    assert.equal(existsSync(conflictingHome), false, "caller identity env does not select persistence");
    assert.equal(runtimeTask(f.store.db, context).generation, d.digest, "historical dispatch does not roll the current task back");
  });
});

test("installed v1 and v2 retain one policy, salt and global ledger while unknown legacy tasks remain on A", {
  skip: !process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE && "An exact installed v1 package fixture is required; never substitute live global paths",
}, async () => {
  const project = await temporaryProject("router-v1-v2-bootstrap-");
  try {
    await withRouterEnvironment(project, async () => {
      const legacyRoot = join(project.root, "legacy-exact-copy"); cpSync(process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE, legacyRoot, { recursive: true });
      const legacy = inspectRuntimePackage(legacyRoot, { legacy: true });
      const [oldDatabase, oldRouter] = await Promise.all([mod(legacyRoot, "database"), mod(legacyRoot, "router")]);
      const oldStore = new oldDatabase.RouterStore();
      const contextId = "legacy-unknown", oldContext = oldStore.context({ cwd: project.root, contextId });
      oldStore.configure(oldContext, { autoActivate: true }, "global");
      const route = await oldRouter.routeStage(routeInput({ contextId }), { store: oldStore, cwd: project.root, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
      assert.equal(route.action, "delegate");
      const beforeAttempt = JSON.stringify(oldStore.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(route.routeId));
      const beforePolicy = JSON.stringify((await mod(legacyRoot, "model-policy-store")).readModelPolicy(oldStore.db));
      const pruned = await oldRouter.routeStage(routeInput({ contextId: "legacy-pruned-no-child" }), { store: oldStore, cwd: project.root, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
      completeNoChildRoute(pruned, { store: oldStore, cwd: project.root, contextId: "legacy-pruned-no-child", status: "failed", failureType: "tooling" });
      oldStore.db.prepare("DELETE FROM delegation_attempts WHERE route_id=?").run(pruned.routeId);
      const prunedOutcome = JSON.stringify(oldStore.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(pruned.routeId));
      const salt = oldStore.salt;
      oldStore.close();
      const candidate = packageAt(join(project.root, "stable-v2-shell"), "0.4.0+v2.cold");
      const compatibilityProof = qualifyRuntimeCompatibility(legacy, candidate, { coldLegacy: true });
      const store = new RouterStore();
      try {
        store.transaction(() => publishRuntime(store.db, candidate, project.home, { bootstrap: true, shellRoot: candidate.root, legacyRuntime: legacy,
          compatibilityProof, coldProof: inspectColdRuntimeTransition(store.db, { inventory: () => [], preserveLegacy: true }) }));
        assert.equal(store.salt, salt);
        assert.equal(JSON.stringify((await mod(candidate.root, "model-policy-store")).readModelPolicy(store.db)), beforePolicy);
        assert.equal(store.getSettings(oldContext).autoActivate, true);
        assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(route.routeId)), beforeAttempt);
        assert.equal(runtimeTask(store.db, oldContext).generation, legacy.digest);
        const historicalCall = beginMcpDispatch("record_outcome", { contextId: "legacy-pruned-no-child", routeId: pruned.routeId }, {
          cwd: project.root, env: { CODEX_THREAD_ID: "legacy-pruned-no-child" } });
        assert.equal(historicalCall.selected.digest, legacy.digest);
        const oldLearning = await mod(legacyRoot, "learning"), historyStore = new oldDatabase.RouterStore();
        try {
          const result = oldLearning.recordOutcome({ contextId: "legacy-pruned-no-child", routeId: pruned.routeId, status: "failed", failureType: "tooling", gate: pruned.verificationGate,
            retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: pruned.escalation.count, userCorrection: false }, { store: historyStore, cwd: project.root });
          assert.equal(result.idempotent, true);
        } finally { historyStore.close(); endRuntimeDispatch(historicalCall); }
        assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(pruned.routeId)), prunedOutcome);
        assert.equal(store.transaction(() => beginRuntimeMigration(store.db, oldContext, boundary(project, contextId))), false);
        const oldCall = beginMcpDispatch("get_route_status", { contextId }, { cwd: project.root, env: { CODEX_THREAD_ID: contextId } });
        assert.equal(oldCall.selected.digest, legacy.digest); endRuntimeDispatch(oldCall);
        const freshContext = store.context({ cwd: project.root, contextId: "fresh-v2" });
        const freshPath = rootTranscript(project, "fresh-v2", []);
        const birth = JSON.parse(readFileSync(freshPath, "utf8")); birth.timestamp = new Date(Date.now() + 1).toISOString();
        writeFileSync(freshPath, JSON.stringify(birth) + "\n");
        endRuntimeDispatch(beginHookDispatch({ hook_event_name: "UserPromptSubmit", session_id: "fresh-v2", cwd: project.root, transcript_path: freshPath, turn_id: "first-v2" }));
        const freshCall = beginMcpDispatch("route_stage", { contextId: "fresh-v2" }, { cwd: project.root, env: { CODEX_THREAD_ID: "fresh-v2" } });
        assert.equal(freshCall.selected.digest, candidate.digest); store.runtimeInvocation = freshCall.invocation;
        const newRoute = await routeStage(routeInput({ contextId: "fresh-v2" }), { store, cwd: project.root, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
        assert.equal(newRoute.action, "delegate"); endRuntimeDispatch(freshCall);
        const reader = new oldDatabase.RouterStore();
        try {
          assert.equal(reader.db.prepare("SELECT count(*) AS n FROM delegation_attempts WHERE finalized_at IS NULL").get().n, 2);
          // A v1 process remains a genuine writer after the cold boundary. Its
          // inherited task's next ticket is pinned by the compatibility trigger.
          completeNoChildRoute(route, { store: reader, cwd: project.root, contextId, status: "failed", failureType: "tooling" });
          const again = await oldRouter.routeStage(routeInput({ contextId }), { store: reader, cwd: project.root, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
          assert.equal(again.action, "delegate");
          assert.equal(store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(again.routeId).generation, legacy.digest);
          const dormantPath = rootTranscript(project, "previously-unseen-dormant", []);
          const dormantBirth = JSON.parse(readFileSync(dormantPath, "utf8")); dormantBirth.timestamp = "2026-09-01T00:00:00.000Z";
          writeFileSync(dormantPath, JSON.stringify(dormantBirth) + "\n");
          const dormant = beginHookDispatch({ hook_event_name: "UserPromptSubmit", session_id: "previously-unseen-dormant", cwd: project.root,
            transcript_path: dormantPath, turn_id: "resumed" });
          assert.equal(dormant.selected.digest, legacy.digest); endRuntimeDispatch(dormant);
          const legacyRpc = rpc(candidate.root, project, contextId), freshRpc = rpc(candidate.root, project, "fresh-v2");
          try {
            for (const [client, digest] of [[legacyRpc, legacy.digest], [freshRpc, candidate.digest]]) {
              const status = await client.call("diagnose_router"); assert.equal(status.result.isError, false);
              assert.equal(status.result.structuredContent.runtime.contentDigest, digest);
            }
          } finally { await legacyRpc.close(); await freshRpc.close(); }
        } finally { reader.close(); }
        assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});
