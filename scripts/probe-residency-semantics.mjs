#!/usr/bin/env node
// Real-model acceptance, separate from the fixed-response protocol probe. The
// whole driver stays outside the installed plugin and cannot confer Hook trust.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { payloadHash } from "../plugins/adaptive-model-router/scripts/lib/io.mjs";
import { databasePath } from "../plugins/adaptive-model-router/scripts/lib/context.mjs";
import { NativeResidencySession, digest, emit } from "./residency-acceptance/native-session.mjs";
import { ledger, collection, dispositions, hasNativeGuardDenial } from "./residency-acceptance/checks.mjs";

if (process.argv.slice(2).some((arg) => arg !== "--preflight") || process.argv.length > 3) throw new Error("Usage: probe-residency-semantics.mjs [--preflight]");
const preflightOnly = process.argv.includes("--preflight");
const session = new NativeResidencySession();
const records = [{ id: "a", value: 17 }, { id: "b", value: 23 }, { id: "c", value: 42 }];
const intent = (value, basis) => ({ intent: value, basis, requirements: [], pendingOperations: [] });
const commandQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const instruction = (marker) => `Return one JSON object with marker=${JSON.stringify(marker)}, requirements (a nonempty array of original requirement descriptions), partialResult (the actual prior result as a nonempty string), and pendingOperations (actual unresolved operations, or []). Only collect facts; no business work.`;
const target = (route) => `/root/${route.carrier.taskName}`;
const outcomeRows = () => session.store.db.prepare("SELECT * FROM outcomes ORDER BY seq").all();
let passed = false;
let failure;

function diagnostics() {
  const contextDigest = payloadHash(session.rootId), authorizationDigest = digest(randomBytes(32));
  const issuedAt = new Date().toISOString();
  const record = { schema: 1, enabled: true, contextDigest, authorizationDigest, issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 3600000).toISOString() };
  // This authorizes private diagnostic logging only. It supplies no lifecycle,
  // delivery, completion, Hook-trust, or admission facts.
  session.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`native_lifecycle_diagnostic:${contextDigest}`, JSON.stringify(record));
  return { path: join(dirname(databasePath()), "diagnostics", `native-lifecycle-${authorizationDigest.slice(0, 24)}.jsonl`),
    stop() { session.store.db.prepare("DELETE FROM meta WHERE key=?").run(`native_lifecycle_diagnostic:${contextDigest}`); } };
}

async function semanticFollowups() {
  const route = await session.route("semantic-requirement-preservation", 'Maintain records a=17 and b=23. Return exactly JSON with keys ids (sorted), sum and count. Later supplemental records must be added without dropping any original record. Use no tools. A requested diagnostic incomplete candidate is not delivery; retain all original records for the next correction.');
  await session.spawn(route);
  const initial = await session.waitChild(route);
  ledger(initial.text, records.slice(0, 2));
  await session.native("followup_task", { target: target(route), message: "Add record c=42 and deliver all current records in the same JSON format." });
  const supplemented = await session.waitChild(route);
  ledger(supplemented.text, records);
  const before = outcomeRows().length;
  await session.native("followup_task", { target: target(route), message: "Diagnostic negative control: return a deliberately incomplete candidate containing only c=42 in the same JSON format. This is not delivery and does not cancel a or b; keep them for the forthcoming correction." });
  const incomplete = await session.waitChild(route);
  ledger(incomplete.text, records.slice(2));
  assert.throws(() => ledger(incomplete.text, records));
  assert.equal(outcomeRows().length, before, "a rejected semantic result must not receive an outcome");
  await session.native("followup_task", { target: target(route), message: "The incomplete candidate failed root verification. Correct it in this same stage and deliver all three required records a=17, b=23, c=42 exactly once." });
  const corrected = await session.waitChild(route);
  ledger(corrected.text, records);
  await assert.rejects(session.outcome(route, supplemented.closure), /closureToken|current|verification/i);
  assert.equal(outcomeRows().length, before);
  await session.outcome(route, corrected.closure);
  session.steps.push({ case: "real-supplement-and-controlled-omission-correction", routeId: route.routeId,
    target: route.target, finalDigest: corrected.closure.resultDigest, revision: corrected.closure.revision,
    outcomeCount: outcomeRows().length - before, intentionalNegativeControl: true });
  emit({ stage: "verified", case: "supplement-and-correction" });
}

function barrierCommand(label) {
  const release = join(session.scratch, `${label}-release`);
  const script = join(session.scratch, `${label}-wait.mjs`);
  session.barriers.add(release);
  writeFileSync(script, `import { existsSync } from 'node:fs';\nconsole.log('PARTIAL_40');\nconst end = Date.now() + 120000;\nwhile (!existsSync(${JSON.stringify(release)})) {\n  if (Date.now() > end) process.exit(68);\n  await new Promise(resolve => setTimeout(resolve, 100));\n}\nconsole.log('BARRIER_RELEASED');\n`);
  return { release, command: `${commandQuote(process.execPath)} ${commandQuote(script)}` };
}

async function runningSupplement() {
  const barrier = barrierCommand("running-supplement");
  const route = await session.route("semantic-actual-running-supplement", `Maintain records a=17 and b=23. First run exactly one native exec_command with cmd=${JSON.stringify(barrier.command)} and yield_time_ms=1000. It is an authorized temporary acceptance process; it prints PARTIAL_40 then waits for the outer driver. Poll only the returned existing session using native write_stdin with empty input until its actual terminal receipt. Do not start another command. Any supplement arriving while this process is running must be added without losing the originals. After the process terminates, return only JSON with sorted ids, sum and count for all current records.`);
  const childId = await session.spawn(route);
  const pending = await session.waitChild(route, { pendingOperation: true });
  assert.equal(pending.pendingOperations.length, 1);
  assert.equal((await session.read(childId)).turns.at(-1).status, "inProgress", "supplement must target an actually running child");
  await session.native("followup_task", { target: target(route), message: "Add c=42 to the current records. Preserve a and b, finish waiting for the already running process, and deliver the complete JSON once it terminates." });
  writeFileSync(barrier.release, "release\n");
  const result = await session.waitChild(route);
  ledger(result.text, records);
  assert.deepEqual(result.facts.pendingOperations, []);
  assert.equal(result.facts.pendingCalls.length, 0);
  await session.outcome(route, result.closure);
  session.steps.push({ case: "actual-running-supplement", routeId: route.routeId, target: route.target,
    finalDigest: result.closure.resultDigest, originalRecordsPreserved: true, realOperationTerminalReceipt: true });
  emit({ stage: "verified", case: "actual-running-supplement" });
}

async function unfinishedOperationCancellation() {
  const marker = `RUNNING_CANCEL_${randomBytes(8).toString("hex")}`;
  const barrier = barrierCommand("running-cancel");
  const route = await session.route("semantic-unfinished-operation-cancellation", `Preserve requirement SOURCE_${marker} and partial result PARTIAL_40. Run exactly one native exec_command with cmd=${JSON.stringify(barrier.command)} and yield_time_ms=1000. Poll only that existing session using native write_stdin with empty input while waiting for its actual terminal receipt. Never launch a second process or repeat business work. If the root changes intent to cancellation, preserve SOURCE_${marker}, PARTIAL_40 and any unresolved native operation identifier for maintenance collection.`);
  const childId = await session.spawn(route);
  const pending = await session.waitChild(route, { pendingOperation: true });
  assert.equal(pending.pendingOperations.length, 1);
  assert.equal((await session.read(childId)).turns.at(-1).status, "inProgress");
  await session.manage(route, "begin_maintenance", { disposition: { ...intent("cancelled", "The acceptance controller explicitly cancels the synthetic stage while its authorized native operation is unfinished."),
    pendingOperations: pending.pendingOperations.map((operation) => JSON.stringify(operation)) } });
  await session.native("interrupt_agent", { target: target(route) });
  writeFileSync(barrier.release, "release\n");
  await session.native("followup_task", { target: target(route), message: `The root has cancelled this stage and released the existing test barrier. Only collect the original requirement, partial result and actual operation state. If an existing native operation remains pending, poll that same handle with the permitted native wait tool and no input; never launch or repeat a command. After verifying its actual termination, ${instruction(marker)}` });
  const result = await session.waitChild(route);
  const collected = collection(result.text, marker);
  assert.ok(JSON.stringify(collected.requirements).includes(`SOURCE_${marker}`));
  assert.ok(collected.partialResult.includes("PARTIAL_40"));
  assert.deepEqual(result.facts.pendingOperations, []);
  await session.manage(route, "verify_maintenance", { closureToken: result.closure.token,
    disposition: dispositions(result.closure, "cancelled", `The root explicitly cancelled SOURCE_${marker} while a native operation was running.`,
      "Verified the actual collection retains the original requirement and PARTIAL_40, and current native evidence has no unfinished call or operation.", "cancelled") });
  await session.outcome(route, result.closure, { status: "failed", failureType: "information" });
  session.steps.push({ case: "unfinished-native-operation-cancellation", routeId: route.routeId,
    finalDigest: result.closure.resultDigest, originalRequirementPreserved: true, partialResultPreserved: true,
    actualOperationReconciled: true });
  emit({ stage: "verified", case: "unfinished-operation-cancellation" });
}

async function cachedMaintenanceGuard() {
  const marker = `COLLECT_${randomBytes(8).toString("hex")}`;
  const sentinel = join(session.scratch, "guard-must-not-write");
  const command = `printf UNEXPECTED > ${commandQuote(sentinel)}`;
  const forwarding = `text(await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 1000 })}));`;
  const invocation = `Attempt exactly one exec_command with cmd=${JSON.stringify(command)} and yield_time_ms=1000. If exec_command is exposed only inside code mode, the functions.exec wrapper is explicitly part of this same authorized test call. Use this JavaScript source verbatim, without another layer of quoting:\n\n\`\`\`javascript\n${forwarding}\n\`\`\`\n\nA nested exec_command is available even when there is no direct tool entry. Do not change the command or add any other operation.`;
  const route = await session.route("semantic-cached-maintenance-guard", `This is a bounded lifecycle guard test. First return GUARD_READY without tools. If the parent later explicitly requests the guard test: ${invocation} Then report its actual denial or execution. That command's only possible effect is the named disposable test sentinel. Never retry the command. Preserve this original instruction and initial result for any collection request.`);
  await session.spawn(route);
  const initial = await session.waitChild(route);
  assert.equal(initial.text.trim(), "GUARD_READY");
  await session.outcome(route, initial.closure);
  const before = outcomeRows();
  // Preserve the actual rejected call in the native parent log. A fixture that
  // simply omits rejected sends cannot catch a poisoned maintenance mailbox.
  await session.native("send_message", { target: target(route),
    message: "Controlled negative guard test: this finalized child must reject delivery. Do not execute business work." });
  const reconciled = await session.manage(route, "reconcile_messages");
  assert.deepEqual(reconciled.pendingCalls, []);
  assert.equal(reconciled.rejectedCalls.length, 1);
  assert.equal(reconciled.rejectedCalls[0].owner, "/root");
  const parent = await session.read(session.rootId);
  const nativeRows = readFileSync(parent.path, "utf8").trimEnd().split("\n").map(JSON.parse);
  const rejected = nativeRows.filter((row) => row.type === "response_item" && row.payload.type === "function_call_output"
    && row.payload.call_id === reconciled.rejectedCalls[0].callId);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].payload.output, /^Tool call blocked by PreToolUse hook: [\s\S]+\. Tool: collaborationsend_message$/u);
  assert.equal(session.store.db.prepare("SELECT status FROM delegation_messages WHERE route_id=? AND call_id=?")
    .get(route.routeId, reconciled.rejectedCalls[0].callId).status, "rejected");
  await session.manage(route, "begin_maintenance", { disposition: intent("collect", "The test stage already has its final outcome; collect its retained instructions and test the actual maintenance guard.") });
  const attempts = session.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n;
  const held = await session.call("route_stage", { stageId: "maintenance-conflict-negative-control", phase: "real-model-residency-acceptance",
    goal: "Guard negative control only: do not launch new work while the prior collection is still active.",
    evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
    hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] } } });
  assert.equal(held.action, "continue");
  assert.deepEqual(held.reasonCodes, ["CHILD_MAINTENANCE_PENDING"]);
  assert.equal(session.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, attempts);
  const diagnostic = diagnostics();
  let trace;
  try {
    await session.native("followup_task", { target: target(route), message: `Perform the previously authorized guard test once. ${invocation} Accept the actual guard denial without retrying, then ${instruction(marker)}` });
    const result = await session.waitChild(route);
    const collected = collection(result.text, marker);
    assert.ok(collected.partialResult.includes("GUARD_READY"));
    assert.equal(existsSync(sentinel), false, "maintenance tool guard failed: the command ran");
    assert.equal(hasNativeGuardDenial(session.locator(route).transcriptPath, initial.facts.lastFinal.line, command), true, "the exact canary needs a native Router refusal; printed text, another command or sandbox rejection is not a guard test");
    assert.ok(statSync(diagnostic.path).size < 60000, "bounded diagnostics filled; absence of Start is unproven");
    trace = readFileSync(diagnostic.path, "utf8").trim().split("\n").map(JSON.parse)
      .filter((entry) => entry.stage === "entry" && entry.fields.agent_id?.digest === payloadHash(session.locator(route).childId));
    assert.ok(trace.some((entry) => entry.mode === "subagent-stop"), "actual collection Stop was not observed");
    assert.equal(trace.filter((entry) => entry.mode === "subagent-start").length, 0, "the cached-followup case did not exercise the no-Start path");
    await session.manage(route, "verify_maintenance", { closureToken: result.closure.token,
      disposition: dispositions(result.closure, "collect", "This same cached child was authorized only to collect its previous test-stage requirements.",
        "Inspected the actual JSON, original GUARD_READY result, native Router tool-denial output, absent sentinel, and current input references.", "no_work") });
    assert.deepEqual(outcomeRows(), before);
    session.steps.push({ case: "cached-child-maintenance-and-real-tool-denial", routeId: route.routeId,
      childId: session.locator(route).childId, finalDigest: result.closure.resultDigest, oldOutcomeUnchanged: true,
      noNewSubagentStart: true, pluginGuardDenial: true, diagnosticDigest: digest(readFileSync(diagnostic.path)) });
    session.steps.push({ case: "native-message-rejection-and-maintenance-admission", routeId: route.routeId,
      nativeRejection: reconciled.rejectedCalls[0], nativeRejectionDigest: digest(JSON.stringify(rejected[0])),
      senderResponsibilityPreserved: true, laterCollectionVerified: true,
      noConflictingAdmission: true, oldOutcomeUnchanged: true });
  } finally { diagnostic.stop(); }
  emit({ stage: "verified", case: "cached-maintenance-guard" });
}

async function explicitIntent(value) {
  const marker = `INTENT_${randomBytes(8).toString("hex")}`;
  const route = await session.route(`semantic-intent-${value}`, `Maintain original requirement SOURCE_${marker}. Calculate 17+23 and return exactly PARTIAL_${marker}_40 without tools. Preserve that requirement and partial result if the parent cancels or defers the stage. Do not perform more business work once the intent changes.`);
  await session.spawn(route);
  const initial = await session.waitChild(route);
  assert.equal(initial.text.trim(), `PARTIAL_${marker}_40`);
  await session.manage(route, "begin_maintenance", { disposition: intent(value, `The acceptance controller explicitly ${value} this unfinished test stage and preserves its requirement for disposition.`) });
  await session.native("followup_task", { target: target(route), message: `The current stage is ${value}. ${instruction(marker)}` });
  const result = await session.waitChild(route);
  const collected = collection(result.text, marker);
  assert.ok(JSON.stringify(collected.requirements).includes(`SOURCE_${marker}`));
  assert.ok(collected.partialResult.includes(`PARTIAL_${marker}_40`));
  const report = dispositions(result.closure, value, `Preserve SOURCE_${marker} and original result PARTIAL_${marker}_40.`,
    `Verified real collection includes SOURCE_${marker}, original partial result and no pending operations.`, value);
  await session.manage(route, "verify_maintenance", { closureToken: result.closure.token, disposition: report });
  await assert.rejects(session.outcome(route, result.closure), /must not be reported as passed/);
  await session.outcome(route, result.closure, { status: "failed", failureType: "information" });
  if (value === "deferred") {
    const before = await session.manage(route, "read_disposition");
    await session.turn("This is the next turn of the same acceptance root. Reply RESUMED. Keep the saved deferred requirement for the outer driver; do not execute it or call tools.", "deferred-root-resume");
    assert.deepEqual(await session.manage(route, "read_disposition"), before);
    const current = await session.call("get_route_status", {});
    assert.ok(current.pendingStageWork.some((item) => item.routeId === route.routeId));
    await session.manage(route, "resolve_requirements", { disposition: { ...report,
      basis: "On the resumed root turn, the acceptance controller explicitly cancels this synthetic deferred requirement after checking its preserved source and partial result.",
      requirements: report.requirements.map((item) => ({ ...item, disposition: "cancelled", receipt: "Original source and partial result were read back unchanged before this explicit root cancellation." })) } });
    assert.equal((await session.call("get_route_status", {})).pendingStageWork.some((item) => item.routeId === route.routeId), false);
  }
  session.steps.push({ case: `real-${value}-collection`, routeId: route.routeId, finalDigest: result.closure.resultDigest,
    originalRequirementPreserved: true, partialResultPreserved: true, rootResumeVerified: value === "deferred" });
  emit({ stage: "verified", case: value });
}

try {
  await session.start({ preflightOnly });
  if (!preflightOnly) {
    await session.qualify();
    await semanticFollowups();
    await runningSupplement();
    await unfinishedOperationCancellation();
    await cachedMaintenanceGuard();
    await explicitIntent("cancelled");
    await explicitIntent("deferred");
    const final = await session.call("get_route_status", {});
    assert.equal(final.delegationGate.state, "available");
    assert.equal(final.pendingOutcomes, 0);
    assert.equal(final.stageClosure, null);
    assert.deepEqual(final.pendingStageWork, []);
  }
  passed = true;
} catch (error) {
  failure = String(error.message).replace(/router_[a-f0-9]{32}/gu, "[carrier]").slice(0,1200);
  process.exitCode = 1;
} finally {
  await session.close();
  if (!session.processGroupAbsent) { passed = false; failure = failure || "owned native host cleanup was not proven"; process.exitCode = 1; }
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), passed, preflightOnly,
    realModelAcceptanceExecuted: session.modelTurns > 0 && !preflightOnly, modelTurnsStarted: session.modelTurns,
    sourceDigest: session.sourceDigest || null, readiness: session.readiness, steps: session.steps,
    remainingCoverage: ["three-backlog native capacity recovery", "original Hosted task recovery", "independent candidate review"],
    cleanup: { ownedProcessGroupAbsent: Boolean(session.processGroupAbsent) }, ...(failure ? { failure } : {}) };
  const output = join(session.scratch, "semantic-report.json");
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  emit({ stage: passed ? "verified" : "stopped", report: output, preflightOnly, modelTurnsStarted: session.modelTurns,
    steps: session.steps.length, ...(failure ? { failure } : {}) });
}
