#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NativeResidencySession, emit } from "./residency-acceptance/native-session.mjs";
import { readChildCommands } from "../plugins/adaptive-model-router/scripts/lib/child-command-journal.mjs";
import { readChildTurnEvidence } from "../plugins/adaptive-model-router/scripts/lib/child-turn-evidence.mjs";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/probe-residency-operations.mjs");
const session = new NativeResidencySession();
const spawn = session.client.spawnImpl;
session.client.spawnImpl = (command, args, options) => spawn(command, ["-c", "features.code_mode_host=true", ...args], options);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
const owned = new Set();
let passed = false, failure;

async function completedChild(route) {
  const id = session.routeChildren.get(route.routeId);
  for (const deadline = Date.now() + 150000; Date.now() < deadline;) {
    const thread = await session.read(id);
    const turn = thread.turns.at(-1);
    if (turn?.status === "completed") return thread;
    if (turn && turn.status !== "inProgress") throw new Error(`child ended ${turn.status}`);
    await pause(1000);
  }
  throw new Error("same child remained in progress beyond the bounded operation probe deadline");
}

function nativeReturns(route, source) {
  const rows = readFileSync(session.locator(route).transcriptPath, "utf8").trim().split("\n").map(JSON.parse);
  const calls = rows.filter((row) => row.type === "response_item" && row.payload?.type === "custom_tool_call");
  assert.equal(calls.length, 1, "only the prescribed native code block may execute");
  assert.equal(calls[0].payload.name, "exec");
  assert.equal(calls[0].payload.input.trim(), source.trim(), "a changed model program is not this control");
  const output = rows.find((row) => row.type === "response_item" && row.payload?.type === "custom_tool_call_output"
    && row.payload.call_id === calls[0].payload.call_id);
  assert.match(output?.payload.output?.[0]?.text || "", /^Script completed\n/u);
  return output.payload.output.slice(1).flatMap((part) => {
    try { const value = JSON.parse(part.text); return value && typeof value.output === "string" ? [value] : []; }
    catch { return []; }
  });
}

async function runningCase(count) {
  const name = count === 1 ? "ordinary-extra-output" : "parallel-extra-output";
  const release = join(session.scratch, `${name}-release`);
  session.barriers.add(release);
  const tokens = Array.from({ length: count }, () => randomUUID());
  const commands = tokens.map((token, index) => {
    const script = join(session.scratch, `${name}-${index}.mjs`);
    writeFileSync(script, `import {existsSync} from 'node:fs';
console.log('OWNED_OPERATION '+JSON.stringify({pid:process.pid,token:${JSON.stringify(token)}}));
const deadline=Date.now()+180000;
while(!existsSync(${JSON.stringify(release)})&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
console.log('OPERATION_EXITED');\n`);
    return { cmd: `${quote(process.execPath)} ${quote(script)}`, yield_time_ms: 1000, max_output_tokens: 500 };
  });
  const source = count === 1
    ? `const receipt = await tools.exec_command(${JSON.stringify(commands[0])});\ntext(receipt);\ntext("EXTRA_OUTPUT");`
    : `const receipts = await Promise.all([${commands.map((args) => `tools.exec_command(${JSON.stringify(args)})`).join(",")}]);\nfor (const receipt of receipts) text(receipt);\ntext("EXTRA_OUTPUT");`;
  const route = await session.route(name, `This is an authorized disposable lifecycle acceptance test. Run exactly this functions.exec source once, verbatim, then immediately return OPERATION_RETURNED. Do not poll, retry, wait for the process, or execute another tool. The outer source driver owns the temporary processes and will release them after independently checking that Router still records them as unfinished.\n\n\`\`\`javascript\n${source}\n\`\`\``);
  await session.spawn(route);
  try {
    await completedChild(route);
    const returned = nativeReturns(route, source);
    assert.equal(returned.length, count);
    const identities = returned.map((receipt) => {
      assert.ok(Number.isSafeInteger(receipt.session_id));
      const line = receipt.output.split("\n").find((entry) => entry.startsWith("OWNED_OPERATION "));
      assert.ok(line); const identity = JSON.parse(line.slice("OWNED_OPERATION ".length));
      assert.ok(tokens.includes(identity.token)); assert.ok(Number.isSafeInteger(identity.pid)); owned.add(identity.pid);
      assert.equal(alive(identity.pid), true); return identity;
    });
    assert.equal(new Set(identities.map((identity) => identity.token)).size, count);
    assert.equal(existsSync(release), false);
    const status = (await session.call("get_route_status", {})).stageClosure;
    assert.equal(status.routeId, route.routeId); assert.equal(status.state, "pending");
    assert.equal(status.reason, "child_operations_pending");
    const commandsBefore = readChildCommands(session.store.db, route.routeId);
    assert.equal(commandsBefore.filter((command) => command.started && !command.terminal).length, count);
    assert.equal(status.pendingOperations.filter((operation) => operation.kind === "command").length, count);
    emit({ stage: "verified-running", case: name, childId: session.locator(route).childId, actualOwnedProcessesAlive: count });
    writeFileSync(release, "release\n");
    for (const deadline = Date.now() + 15000; Date.now() < deadline && identities.some((identity) => alive(identity.pid));) await pause(100);
    for (const identity of identities) { assert.equal(alive(identity.pid), false); owned.delete(identity.pid); }
    const result = await session.waitChild(route);
    const commandsAfter = readChildCommands(session.store.db, route.routeId);
    const facts = readChildTurnEvidence(session.locator(route), { commands: commandsAfter });
    assert.deepEqual(facts.pendingOperations, []);
    assert.equal(facts.commandCompletions.length, count, "natural exit must have exact native command receipts, without a new poll");
    assert.equal(result.text.trim(), "OPERATION_RETURNED");
    await session.outcome(route, result.closure);
    session.steps.push({ case: name, routeId: route.routeId, childId: session.locator(route).childId,
      target: route.target, commands: count, runningObservedBeforeRelease: true, pendingBeforeRelease: true,
      nativeNaturalExits: facts.commandCompletions, extraPolls: 0, actualOwnedProcessesExited: true });
  } finally { writeFileSync(release, "release\n"); }
}

async function nonzeroCase() {
  const script = join(session.scratch, "expected-nonzero.mjs");
  writeFileSync(script, "console.log('EXPECTED_NONZERO');process.exit(7);\n");
  const args = { cmd: `${quote(process.execPath)} ${quote(script)}`, yield_time_ms: 1000, max_output_tokens: 500 };
  const source = `const receipt = await tools.exec_command(${JSON.stringify(args)});\ntext(receipt);\ntext("EXTRA_OUTPUT");`;
  const route = await session.route("expected-nonzero-exit", `This disposable acceptance test deliberately expects exit code 7. Run this functions.exec source exactly once and verbatim, then return EXPECTED_NONZERO_OBSERVED. Do not retry or attempt to repair the test command.\n\n\`\`\`javascript\n${source}\n\`\`\``);
  await session.spawn(route);
  const result = await session.waitChild(route);
  const [returned] = nativeReturns(route, source);
  assert.equal(returned.exit_code, 7); assert.match(returned.output, /EXPECTED_NONZERO/u);
  const commands = readChildCommands(session.store.db, route.routeId);
  assert.equal(commands.length, 1); assert.equal(commands[0].terminal, true, "the native Bash Post must close a nonzero result too");
  assert.deepEqual(readChildTurnEvidence(session.locator(route), { commands }).pendingOperations, []);
  assert.equal(result.text.trim(), "EXPECTED_NONZERO_OBSERVED");
  await session.outcome(route, result.closure);
  session.steps.push({ case: "expected-nonzero-exit", routeId: route.routeId, childId: session.locator(route).childId,
    target: route.target, actualExitCode: 7, nativePostObserved: true, retried: false });
}

async function interceptedPatchCase() {
  const path = join(session.scratch, "intercepted-patch-result.txt");
  const expected = `PATCH_RESULT_${randomUUID()}\n`;
  assert.equal(existsSync(path), false);
  const args = { cmd: `apply_patch <<'ROUTER_NATIVE_PATCH'\n*** Begin Patch\n*** Add File: ${path}\n+${expected}*** End Patch\nROUTER_NATIVE_PATCH`,
    workdir: session.scratch, login: false, max_output_tokens: 500 };
  const source = `const receipt = await tools.exec_command(${JSON.stringify(args)});\ntext(receipt);\ntext("EXTRA_OUTPUT");`;
  const route = await session.route("intercepted-patch-exit", `This is an authorized disposable acceptance test. You may create exactly ${path} inside this temporary test workspace. Run this functions.exec source once and verbatim, then return PATCH_RESULT_CREATED. The outer driver verifies the actual file and native completion. Do not use another tool, retry, edit another file, or replace exec_command with direct apply_patch.\n\n\`\`\`javascript\n${source}\n\`\`\``);
  await session.spawn(route);
  const result = await session.waitChild(route);
  const returned = nativeReturns(route, source);
  assert.equal(returned.length, 1); assert.equal(returned[0].session_id, undefined);
  assert.equal(readFileSync(path, "utf8"), expected);
  const commands = readChildCommands(session.store.db, route.routeId);
  assert.equal(commands.length, 1); assert.equal(commands[0].terminal, false, "the intercepted native path has no Bash Post");
  const facts = readChildTurnEvidence(session.locator(route), { commands });
  assert.deepEqual(facts.pendingOperations, []); assert.equal(facts.commandCompletions.length, 1);
  assert.equal(facts.commandCompletions[0].source, "native_file_change");
  assert.equal(facts.commandCompletions[0].status, "completed");
  assert.equal(result.text.trim(), "PATCH_RESULT_CREATED");
  await session.outcome(route, result.closure);
  session.steps.push({ case: "intercepted-patch-exit", routeId: route.routeId, childId: session.locator(route).childId,
    target: route.target, exactArtifactContentVerified: true, artifactPath: path,
    nativePostObserved: false, nativeCompletion: facts.commandCompletions[0], retried: false });
}

try {
  // Writes are permitted only in this driver's disposable scratch workspace;
  // other residency drivers keep the shared session's read-only default.
  await session.start({ allowScratchWrites: true }); await session.qualify();
  await runningCase(1); await runningCase(2); await nonzeroCase(); await interceptedPatchCase();
  passed = true;
} catch (error) { failure = error.message; process.exitCode = 1; }
finally {
  await session.close();
  const remaining = [...owned].filter(alive);
  if (!session.processGroupAbsent || remaining.length) { passed = false; failure ||= "owned operation cleanup failed"; process.exitCode = 1; }
  const report = { schemaVersion: 1, kind: "native-command-journal-acceptance", passed,
    requestedMode: "real-model", realModelExecutionStarted: session.modelTurns > 0,
    sourceDigest: session.sourceDigest, rootId: session.rootId, steps: session.steps, modelTurns: session.modelTurns,
    cleanup: { ownedProcessGroupAbsent: session.processGroupAbsent, ownedProcessesAbsent: remaining.length === 0 },
    ...(failure ? { failure } : {}) };
  const path = join(session.scratch, "operation-report.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n"); emit({ stage: "finished", report: path, passed, ...(failure ? { failure } : {}) });
}
