#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeResidencySession, emit } from "./residency-acceptance/native-session.mjs";
import { readChildCommands } from "../plugins/adaptive-model-router/scripts/lib/child-command-journal.mjs";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/probe-residency-exceptions.mjs");
const session = new NativeResidencySession();
const spawn = session.client.spawnImpl;
session.client.spawnImpl = (command, args, options) => spawn(command, ["-c", "features.code_mode_host=true", ...args], options);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = false, failure;

try {
  await session.start({ allowScratchWrites: true, allowRootVerification: true });
  await session.qualify();
  const missingCwd = join(session.scratch, "deliberately-missing-cwd");
  const forbiddenArtifact = join(session.scratch, "must-not-be-created.txt");
  const args = { cmd: `printf 'UNEXPECTED_EXECUTION' > ${quote(forbiddenArtifact)}`, workdir: missingCwd,
    login: false, yield_time_ms: 1000, max_output_tokens: 1000 };
  const source = `text(await tools.exec_command(${JSON.stringify(args)}));`;
  const route = await session.route("native-creation-failure", `This disposable acceptance test deliberately requests a nonexistent working directory and expects native command creation to fail. Run exactly this functions.exec source once. After the actual failure, return EXPECTED_CREATION_FAILURE. Do not create the directory, repair or retry the command, poll, use any other tool, or hide the actual failure.\n\n${source}`);
  await session.spawn(route);
  let thread;
  for (const deadline = Date.now() + 150000; Date.now() < deadline;) {
    thread = await session.read(session.routeChildren.get(route.routeId));
    if (thread.turns.at(-1)?.status === "completed") break;
    if (thread.turns.at(-1)?.status !== "inProgress") throw new Error("creation-failure child did not complete normally");
    await pause(1000);
  }
  assert.equal(thread.turns.at(-1)?.status, "completed");
  assert.equal(existsSync(missingCwd), false); assert.equal(existsSync(forbiddenArtifact), false);
  const rows = readFileSync(session.locator(route).transcriptPath, "utf8").trim().split("\n").map(JSON.parse);
  const calls = rows.filter((row) => row.type === "response_item" && row.payload?.type === "custom_tool_call");
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.name, "exec"); assert.equal(calls[0].payload.input.trim(), source);
  const actual = rows.find((row) => row.type === "response_item" && row.payload?.type === "custom_tool_call_output" && row.payload.call_id === calls[0].payload.call_id);
  assert.match(JSON.stringify(actual?.payload.output), /No such file or directory|os error 2|Failed to create unified exec process/u);
  const commands = readChildCommands(session.store.db, route.routeId);
  assert.equal(commands.length, 1); assert.equal(commands[0].started, true); assert.equal(commands[0].terminal, false);
  let view = await session.manage(route, "read_operations");
  assert.equal(view.operations.length, 1); assert.equal(view.operations[0].kind, "command");
  const unresolved = { operationId: view.operations[0].operationId, original: view.operations[0].origin, evidence: [],
    conclusion: "unresolved", basis: "The exact native command creation failed; the root must inspect the actual error and workspace before clearing it.",
    resultReview: "No successful execution is claimed. The actual missing-directory error is retained in the child's original tool result.",
    unresolved: { source: `native child ${view.childId}, command ${commands[0].callId}`, owner: "/root",
      nextStep: "Inspect the exact original error and verify the missing working directory and absent owned artifact.", resumeCondition: "The root's native verification command returns its actual result." } };
  await session.manage(route, "reconcile_operations", { operationReview: { snapshotDigest: view.snapshotDigest, items: [unresolved] } });
  assert.equal((await session.call("get_route_status", {})).stageClosure.state, "pending");
  const verificationFile = join(session.scratch, "verify-creation-failure.mjs");
  writeFileSync(verificationFile, `import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
assert.equal(existsSync(${JSON.stringify(missingCwd)}),false);assert.equal(existsSync(${JSON.stringify(forbiddenArtifact)}),false);
console.log('EXACT_CREATION_FAILURE_STATE_VERIFIED');\n`);
  const verificationSource = `text(await tools.exec_command(${JSON.stringify({ cmd: `${quote(process.execPath)} ${quote(verificationFile)}`,
    workdir: session.scratch, login: false, max_output_tokens: 1000 })}));`;
  await session.turn(`ROOT_OPERATION_VERIFICATION. Execute exactly this functions.exec source once, then return ROOT_VERIFIED. It verifies only the two owned temporary paths after the actual child error. Do not retry or run another tool.\n\n${verificationSource}`, "root-creation-verification");
  view = await session.manage(route, "read_operations");
  assert.equal(view.operations[0].review.unresolved.owner, "/root");
  assert.ok(view.rootEvidence.length, "root verification must exist as an actual native result");
  const resolved = { ...unresolved, original: view.operations[0].origin, conclusion: "not_started", evidence: [view.rootEvidence.at(-1)],
    basis: "The exact native tool returned command creation failure for the nonexistent cwd, before the shell could execute; no process handle or command terminal was returned.",
    resultReview: "Inspected the original native error, verified the missing cwd and absent exact artifact through the root's native command, and retained the failure as the expected test result." };
  delete resolved.unresolved;
  const review = { snapshotDigest: view.snapshotDigest, items: [resolved] };
  const forged = structuredClone(review); forged.items[0].evidence[0].digest = "0".repeat(64);
  await assert.rejects(session.manage(route, "reconcile_operations", { operationReview: forged }), /evidence|reference/);
  await session.manage(route, "reconcile_operations", { operationReview: review });
  const replay = await session.manage(route, "reconcile_operations", { operationReview: review, expectedRevision: view.revision });
  assert.equal(replay.idempotent, true);
  const result = await session.waitChild(route);
  assert.equal(result.text.trim(), "EXPECTED_CREATION_FAILURE");
  await session.outcome(route, result.closure);
  assert.equal(readChildCommands(session.store.db, route.routeId)[0].terminal, false, "exception review cannot fabricate a Bash Post");
  session.steps.push({ case: "actual-native-creation-failure", routeId: route.routeId, childId: view.childId,
    originalCallId: commands[0].callId, unresolvedOwnerRetained: true, rootNativeVerification: view.rootEvidence.at(-1),
    forgedReferenceRejected: true, replayIdempotent: true, actualArtifactAbsent: !existsSync(forbiddenArtifact), nativePostInvented: false });
  const next = await session.route("after-exception-new-stage", "Return AFTER_EXCEPTION_OK without tools.");
  await session.spawn(next); const nextResult = await session.waitChild(next);
  assert.equal(nextResult.text.trim(), "AFTER_EXCEPTION_OK"); await session.outcome(next, nextResult.closure);
  session.steps.push({ case: "same-root-new-delegation-after-exception", routeId: next.routeId, childId: session.locator(next).childId });
  passed = true;
} catch (error) { failure = error.message; process.exitCode = 1; }
finally {
  await session.close();
  if (!session.processGroupAbsent) { passed = false; failure ||= "owned process group cleanup failed"; process.exitCode = 1; }
  const path = join(session.scratch, "exception-report.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, kind: "native-operation-exception-acceptance", passed,
    sourceDigest: session.sourceDigest, rootId: session.rootId, modelTurns: session.modelTurns,
    steps: session.steps, cleanup: { ownedProcessGroupAbsent: session.processGroupAbsent }, ...(failure ? { failure } : {}) }, null, 2) + "\n");
  emit({ stage: "finished", report: path, passed, ...(failure ? { failure } : {}) });
}
