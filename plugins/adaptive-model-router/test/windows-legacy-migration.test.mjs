import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { archiveHistoricalRuntime } from "./support/historical-runtime.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { qualifyHostEpochPublication, publishHostEpoch, prepareHostEpochHandover, commitHostEpochHandover } from "../scripts/lib/runtime-epoch.mjs";
import { beginHookDispatch, endRuntimeDispatch } from "../scripts/lib/runtime-dispatch.mjs";
import { lifecycleBinding } from "../scripts/lib/lifecycle-qualification.mjs";
import { resolveHookIdentity } from "../scripts/lib/hook-identity.mjs";
import { recordHookIdentityDiagnostic } from "../scripts/lib/hook-diagnostics.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { prepareRuntimeHostEntry } from "../scripts/lib/runtime-host-entry.mjs";
import { prepareColdHostEpochInstallation, relocateColdHostEpochEntries, inspectColdHostEpochRetirement,
  commitColdHostEpochRetirement, restoreColdHostEpochEntries } from "../scripts/lib/runtime-cold-install.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedDigest = "14af4672a694ed4093489ced95a5e72b13063bb000dcf343e6843bef660215eb";
let work, legacy;
before(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "router-windows-legacy-")));
  const archived = archiveHistoricalRuntime(resolve(source, "../.."), "4165bc15af853e2e6eb04cfbb81db96747cad8a7");
  assert.equal(archived.status, 0, "The exact historical source must be available");
  assert.equal(spawnSync("tar", ["-xf", "-", "-C", work], { input: archived.stdout }).status, 0);
  const root = join(work, "plugins/adaptive-model-router");
  // The installed Windows package has exactly these 136 historical files,
  // all checked out as CRLF. Reconstruct test bytes, never rewrite an entry.
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  assert.equal(files.length, 136);
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/gu, "\r\n"));
  }
  legacy = inspectRuntimePackage(root, { legacy: true });
  assert.equal(legacy.digest, installedDigest, "Every reconstructed byte must match the installed baseline");
});
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

test("exact Windows v1 qualifies with its original four-slot limit and v2's ten-slot limit", () => {
  assert.ok(qualifyHostEpochPublication(legacy, inspectRuntimePackage(source), { cold: true }));
  assert.equal(inspectRuntimePackage(legacy.root, { legacy: true }).digest, installedDigest);
});

test("the Windows admission rejects changed bytes and cannot authorize a hot v1 transition", () => {
  const changed = join(work, "changed");
  cpSync(legacy.root, changed, { recursive: true });
  writeFileSync(join(changed, "unreviewed.txt"), "not part of the installed baseline\n");
  assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(changed, { legacy: true }),
    inspectRuntimePackage(source), { cold: true }), /unreviewed_legacy_source/u);
  assert.throws(() => qualifyHostEpochPublication(legacy, inspectRuntimePackage(source)), /v1_native_entry_retirement_unproven/u);
});

test("Windows cold enrollment, retirement and recovery preserve pending v1 business and its salt", async () => {
  const project = await temporaryProject("router-windows-cold-");
  try { await withRouterEnvironment(project, async () => {
    const entry = join(process.env.CODEX_HOME, "plugins/cache/adaptive-model-router/adaptive-model-router", legacy.descriptor.runtimeVersion);
    cpSync(legacy.root, entry, { recursive: true });
    const { RouterStore: OldStore } = await import(pathToFileURL(join(entry, "scripts/lib/database.mjs")));
    const { routeStage } = await import(pathToFileURL(join(entry, "scripts/lib/router.mjs")));
    const old = new OldStore();
    const business = db => JSON.stringify(["routes", "outcomes", "delegation_attempts"].map(table =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    let before, salt;
    try {
      const levels = ["low", "medium", "high", "xhigh", "max", "ultra"];
      const route = await routeStage({ contextId: "existing-windows-task", goal: "Implement the parser with tests", phase: "implementation",
        evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
        hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: "gpt-6-astra", efforts: levels }] } } },
      { store: old, cwd: project.root, catalog: [{ slug: "gpt-6-astra", visibility: "list", priority: 0, supported_reasoning_levels: levels }],
        enforceLifecycleHooks: false, diskProbe: () => 20n * 1024n ** 3n });
      assert.equal(route.action, "delegate");
      before = business(old.db); salt = old.db.prepare("SELECT value FROM meta WHERE key='local_salt'").get().value;
    } finally { old.close(); }
    const candidate = prepareRuntimeHostEntry(source, join(project.root, "market/plugin"), project.home);
    const store = new RouterStore();
    try {
      const prepared = prepareColdHostEpochInstallation(store, { source: inspectRuntimePackage(entry, { legacy: true }),
        candidate, shellRoot: candidate.root });
      assert.equal(prepared.taskBindingsChanged, 0);
      assert.equal(prepared.pendingMessages.length, 0);
      assert.equal(business(store.db), before);
      assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='local_salt'").get().value, salt);
      assert.equal(store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, installedDigest);
      const originalTask = store.db.prepare("SELECT * FROM runtime_tasks").all();
      // Isolated OS-boundary fixture only; real installation uses native inventory.
      relocateColdHostEpochEntries(store, prepared.id, { inventory: () => [] });
      commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, prepared.id, { inventory: () => [] }));
      assert.equal(store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, candidate.digest);
      assert.deepEqual(store.db.prepare("SELECT * FROM runtime_tasks").all(), originalTask);
      assert.equal(business(store.db), before);
      restoreColdHostEpochEntries(store, prepared.id, { inventory: () => [] });
      assert.equal(inspectRuntimePackage(entry, { legacy: true }).digest, installedDigest);
      assert.equal(business(store.db), before);
      assert.equal(store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, installedDigest);
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
});

test("a later v2 task handover independently verifies retained Windows v1 retirement and publication", async () => {
  const project = await temporaryProject("router-windows-retained-");
  try { await withRouterEnvironment(project, async () => {
    const entry = join(process.env.CODEX_HOME, "plugins/cache/adaptive-model-router/adaptive-model-router", legacy.descriptor.runtimeVersion);
    cpSync(legacy.root, entry, { recursive: true });
    const shell = prepareRuntimeHostEntry(source, join(project.root, "market/plugin"), project.home);
    const store = new RouterStore();
    try {
      const installation = prepareColdHostEpochInstallation(store, { source: inspectRuntimePackage(entry, { legacy: true }), candidate: shell, shellRoot: shell.root });
      relocateColdHostEpochEntries(store, installation.id, { inventory: () => [] });
      commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, installation.id, { inventory: () => [] }));
      const repaired = join(project.root, "repaired"); cpSync(shell.root, repaired, { recursive: true });
      writeFileSync(join(repaired, "reviewed-release.txt"), "Separate qualified repair generation.\n");
      const candidate = inspectRuntimePackage(repaired);
      publishHostEpoch(store, qualifyHostEpochPublication(shell, candidate));
      const contextId = "post-install-v2-task", turnId = "finished-native-turn", transcriptPath = join(project.root, "root.jsonl");
      writeFileSync(transcriptPath, [
        { type: "session_meta", timestamp: new Date(Date.now() + 1000).toISOString(), payload: { id: contextId, cwd: project.root } },
        { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
      ].map(JSON.stringify).join("\n") + "\n");
      const input = { hook_event_name: "Stop", session_id: contextId, turn_id: turnId, cwd: project.root, transcript_path: transcriptPath };
      const dispatched = beginHookDispatch(input, { shellRoot: shell.root }); endRuntimeDispatch(dispatched);
      assert.equal(dispatched.selected.digest, shell.digest);
      const context = store.context({ cwd: project.root, contextId, create: false });
      recordHookIdentityDiagnostic(resolveHookIdentity(input).audit, "identity_accepted", process.env, { contextId, turnId });
      const binding = lifecycleBinding([], shell.root, shell.root, { cliVersion: "0.153.4", platform: "win32" }, project.root);
      const prepare = () => prepareHostEpochHandover(store, { contextId, turnId, cwd: project.root, transcriptPath },
        { candidate: candidate.digest, shellRoot: shell.root, inspect: async () => ({ binding }) });
      await assert.rejects(prepare(), /retained_legacy_epoch_publication_missing/);
      publishHostEpoch(store, qualifyHostEpochPublication(legacy, candidate, { cold: true }));
      cpSync(legacy.root, entry, { recursive: true });
      await assert.rejects(prepare(), /cold_old_entry_still_executable_or_restored/);
      rmSync(entry, { recursive: true });
      const stale = await prepare();
      cpSync(legacy.root, entry, { recursive: true });
      assert.throws(() => commitHostEpochHandover(store, stale), /cold_old_entry_still_executable_or_restored/);
      assert.equal(store.db.prepare("SELECT generation FROM runtime_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey).generation, shell.digest);
      rmSync(entry, { recursive: true });
      const token = await prepare();
      assert.equal(commitHostEpochHandover(store, token).generation, candidate.digest);
      assert.equal(store.db.prepare("SELECT generation FROM runtime_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey).generation, candidate.digest);
      assert.ok(store.db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=?").get(entry), "Retired registration is preserved");
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
});
