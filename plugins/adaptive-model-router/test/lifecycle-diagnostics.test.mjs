import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { readThreadSpawnIdentity } from "../scripts/lib/subagent-session.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const privatePosixModes = {
  skip: process.platform === "win32" ? "Windows cannot attest private POSIX file modes; refusal is tested separately" : false,
};

test("identity diagnostics distinguish absent metadata from rejected identity without changing admission", () => {
  const observations = [];
  const input = { session_id: "parent-secret", agent_id: "child-secret", transcript_path: "/private/secret.jsonl" };
  assert.equal(readThreadSpawnIdentity(input, { readLine: () => { throw Object.assign(new Error("secret"), { code: "ENOENT" }); },
    onDiagnostic: (value) => observations.push(value) }), null);
  assert.equal(observations[0]?.reason, "metadata_not_found");
  const meta = { type: "session_meta", payload: { id: "different-child", session_id: input.session_id,
    parent_thread_id: input.session_id, agent_path: "/root/task", source: { subagent: { thread_spawn: {
      parent_thread_id: input.session_id, depth: 1, agent_path: "/root/task",
    } } } } };
  assert.equal(readThreadSpawnIdentity(input, { readLine: () => JSON.stringify(meta),
    onDiagnostic: (value) => observations.push(value) }), null);
  assert.equal(observations[1]?.reason, "identity_mismatch");
  assert.equal(observations[1]?.childMatches, false);
  assert.doesNotMatch(JSON.stringify(observations), /secret|private|different-child/);
});

async function withConcurrentDiagnostic(run) {
  const { createLifecycleDiagnostic } = await import("../scripts/lib/lifecycle-diagnostics.mjs");
  const project = await temporaryProject("router-diagnostic-concurrency-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const workers = [];
      const releasePath = join(project.root, "release-diagnostic-writers");
      try {
        const input = { session_id: "concurrent-diagnostic-secret", cwd: project.root };
        const issuedAt = new Date().toISOString();
        store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(
          `native_lifecycle_diagnostic:${payloadHash(input.session_id)}`,
          JSON.stringify({ schema: 1, enabled: true, contextDigest: payloadHash(input.session_id),
            authorizationDigest: "b".repeat(64), taskCwdDigest: payloadHash(realpathSync(project.root)),
            issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 3600000).toISOString() }));
        const trace = createLifecycleDiagnostic(input, "subagent-start");
        const path = join(project.home, "diagnostics", "native-lifecycle-bbbbbbbbbbbbbbbbbbbbbbbb.jsonl");
        const startWriter = (boundary) => {
          const child = spawn(process.execPath, [fileURLToPath(new URL("./diagnostic-worker.mjs", import.meta.url)),
            boundary, JSON.stringify(input), releasePath], { cwd: project.root, stdio: ["ignore", "pipe", "pipe"] });
          let output = "", errors = "", readyResolve, readyReject;
          const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
          child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) readyResolve(); });
          child.stderr.on("data", (chunk) => { errors += chunk; });
          child.on("error", readyReject);
          const done = new Promise((resolve) => child.on("close", (code) => {
            if (!output.includes("ready\n")) readyReject(new Error(errors || "writer exited before barrier"));
            resolve({ code, errors });
          }));
          const worker = { child, ready, done };
          workers.push(worker);
          return worker;
        };
        await run({ store, input, trace, path, startWriter, release: () => writeFileSync(releasePath, "release") });
      } finally {
        writeFileSync(releasePath, "release");
        await Promise.allSettled(workers.map((worker) => worker.done));
        store.close();
      }
    });
  } finally { await project.cleanup(); }
}

test("concurrent diagnostics stay within the documented bounded in-flight allowance", privatePosixModes, async () => {
  await withConcurrentDiagnostic(async ({ trace, path, startWriter, release }) => {
    const entryBytes = statSync(path).size;
    assert.ok(entryBytes > 0 && entryBytes <= 4096, "diagnostic entry must be written before filling its budget");
    while (65536 - statSync(path).size >= 2 * entryBytes) {
      const previous = statSync(path).size;
      trace("entry");
      assert.equal(statSync(path).size, previous + entryBytes, "diagnostic fill must make progress");
    }
    const before = statSync(path).size;
    const workers = [startWriter("size"), startWriter("size")];
    await Promise.all(workers.map((worker) => worker.ready));
    release();
    for (const result of await Promise.all(workers.map((worker) => worker.done))) assert.equal(result.code, 0, result.errors);
    assert.equal(statSync(path).size, before + 2 * entryBytes);
    assert.ok(statSync(path).size > 65536);
    assert.ok(statSync(path).size <= 65536 + 2 * 4096);
    const content = readFileSync(path, "utf8");
    trace("entry");
    assert.equal(readFileSync(path, "utf8"), content);
  });
});

test("closing diagnostics rejects new records while an already admitted write may finish", privatePosixModes, async () => {
  const { closeQualificationDiagnostics } = await import("../scripts/lib/qualification-retry.mjs");
  await withConcurrentDiagnostic(async ({ store, input, trace, path, startWriter, release }) => {
    const before = readFileSync(path, "utf8");
    const worker = startWriter("write");
    await worker.ready;
    assert.equal(closeQualificationDiagnostics(store, input.session_id).status, "closed");
    trace("result", { claimed: false });
    assert.equal(readFileSync(path, "utf8"), before);
    release();
    const result = await worker.done;
    assert.equal(result.code, 0, result.errors);
    const after = readFileSync(path, "utf8");
    assert.equal(after.length, 2 * before.length);
    assert.deepEqual(after.trim().split("\n").map(JSON.parse).map((row) => row.stage), ["entry", "entry"]);
    trace("result", { claimed: false });
    assert.equal(readFileSync(path, "utf8"), after);
  });
});

test("diagnostics refuse non-private file modes without changing Hook stdout", async () => {
  const { createLifecycleDiagnostic } = await import("../scripts/lib/lifecycle-diagnostics.mjs");
  const { closeQualificationDiagnostics } = await import("../scripts/lib/qualification-retry.mjs");
  await withConcurrentDiagnostic(async ({ store, input, trace, path }) => {
    chmodSync(path, 0o644);
    assert.notEqual(statSync(path).mode & 0o077, 0);
    const before = readFileSync(path, "utf8");
    if (process.platform === "win32") assert.equal(before, "");
    trace("result", { claimed: false });
    createLifecycleDiagnostic(input, "subagent-start")("identity", { reason: "identity_mismatch" });
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url)), "subagent-start"],
      { input: JSON.stringify({ ...input, transcript_path: null }), encoding: "utf8", cwd: input.cwd, timeout: 5000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "");
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(closeQualificationDiagnostics(store, input.session_id).status, "closed");
  });
});

test("lifecycle diagnostics are task-scoped, bounded, expiring, redacted and separately closed", privatePosixModes, async () => {
  const { createLifecycleDiagnostic } = await import("../scripts/lib/lifecycle-diagnostics.mjs");
  const { closeQualificationDiagnostics } = await import("../scripts/lib/qualification-retry.mjs");
  const project = await temporaryProject("router-diagnostic-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const secret = "diagnostic-secret";
        const input = { session_id: secret, agent_id: "child-secret", cwd: project.root,
          transcript_path: "/private/secret.jsonl", prompt: secret, tool_input: { message: secret } };
        const quiet = createLifecycleDiagnostic(input, "subagent-start");
        quiet("identity", { reason: "identity_mismatch" });
        const issuedAt = new Date().toISOString();
        const record = { schema: 1, enabled: true, contextDigest: payloadHash(secret),
          authorizationDigest: "a".repeat(64), taskCwdDigest: payloadHash(realpathSync(project.root)),
          issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 3600000).toISOString() };
        const key = `native_lifecycle_diagnostic:${payloadHash(secret)}`;
        store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify(record));
        createLifecycleDiagnostic({ ...input, session_id: "other-task" }, "subagent-start")("identity", {});
        const trace = createLifecycleDiagnostic(input, "subagent-start");
        trace("identity", { reason: "identity_mismatch", childMatches: false, prompt: secret, path: secret });
        trace("result", { claimed: false });
        const directory = join(project.home, "diagnostics");
        const files = readdirSync(directory);
        assert.deepEqual(files, ["native-lifecycle-aaaaaaaaaaaaaaaaaaaaaaaa.jsonl"]);
        const path = join(directory, files[0]);
        let content = readFileSync(path, "utf8");
        assert.doesNotMatch(content, /diagnostic-secret|child-secret|private|prompt|tool_input/);
        assert.deepEqual(content.trim().split("\n").map((line) => JSON.parse(line).stage), ["entry", "identity", "result"]);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const child = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url)), "subagent-start"],
          { input: JSON.stringify({ ...input, transcript_path: null }), encoding: "utf8", cwd: project.root, timeout: 5000 });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout, "");
        const observed = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(observed.some((row) => row.reason === "missing_input_fields" && row.facts.pathPresent === false), true);
        for (let index = 0; index < 100; index += 1) trace("result", { claimed: false });
        assert.ok(statSync(path).size <= 65536);
        content = readFileSync(path, "utf8");
        closeQualificationDiagnostics(store, secret);
        createLifecycleDiagnostic(input, "subagent-start")("identity", {});
        trace("result", { claimed: true });
        assert.equal(readFileSync(path, "utf8"), content);
        store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({ ...record, expiresAt: issuedAt }), key);
        createLifecycleDiagnostic(input, "subagent-start")("identity", {});
        assert.equal(readFileSync(path, "utf8"), content);
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
});
