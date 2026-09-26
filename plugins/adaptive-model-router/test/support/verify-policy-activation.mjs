// Offline integration with exact retained packages. This is not logged-in
// native smoke: only fixture-owned invocations and state are created.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [sourceRoot, candidateRoot] = process.argv.slice(2);
assert.ok(sourceRoot && candidateRoot, "exact source and candidate packages are required");
const home = realpathSync(mkdtempSync(join(tmpdir(), "router-writer-qualification-")));
for (const key of Object.keys(process.env)) if (key.startsWith("ADAPTIVE_ROUTER_") || ["PLUGIN_ROOT", "PLUGIN_DATA", "CODEX_THREAD_ID"].includes(key)) delete process.env[key];
Object.assign(process.env, { CODEX_HOME: join(home, "codex"), CODEX_SQLITE_HOME: join(home, "codex"),
  ADAPTIVE_ROUTER_HOME: join(home, "state"), PLUGIN_DATA: join(home, "state"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1" });
const moduleAt = (root, name) => import(pathToFileURL(join(root, "scripts/lib", `${name}.mjs`)));
let store, legacyStore;
try {
  const [{ inspectRuntimePackage }, { qualifyHostEpochPublication, publishHostEpoch }, isolation, { RouterStore }, api, models] = await Promise.all([
    moduleAt(candidateRoot, "runtime-package"), moduleAt(candidateRoot, "runtime-epoch"), moduleAt(candidateRoot, "runtime-isolation"),
    moduleAt(candidateRoot, "database"), moduleAt(candidateRoot, "model-policy-store"), moduleAt(candidateRoot, "model-policy")]);
  const source = inspectRuntimePackage(sourceRoot, { legacy: JSON.parse(readFileSync(join(sourceRoot, "runtime.json"))).shellProtocolVersion === 1 });
  const candidate = inspectRuntimePackage(candidateRoot);
  const publication = qualifyHostEpochPublication(source, candidate, { cold: true });
  store = new RouterStore(); assert.equal(store.path, join(home, "state/router.sqlite3"));
  store.transaction(() => isolation.publishRuntime(store.db, source, join(home, "state"), { bootstrap: true, shellRoot: source.root }));
  publishHostEpoch(store, publication);
  const A = await moduleAt(source.root, "database"), router = await moduleAt(source.root, "router"), oldApi = await moduleAt(source.root, "model-policy-store");
  legacyStore = new A.RouterStore(); assert.equal(legacyStore.path, store.path);
  const contextId = "retained-original-work", context = legacyStore.context({ cwd: home, contextId });
  store.transaction(() => isolation.ensureRuntimeTask(store.db, context, { trustedHook: true }));
  const originalCall = store.transaction(() => isolation.acquireRuntimeInvocation(store.db, context, { kind: "mcp:route_stage", generation: source.digest })).invocation;
  legacyStore.runtimeInvocation = originalCall;
  const catalog = models.DEFAULT_MODEL_POLICY.definition.allowedModels.map((entry, index) => ({ slug: entry.model, visibility: "list", priority: index, supported_reasoning_levels: entry.efforts }));
  const route = await router.routeStage({ contextId, goal: "Review retained Unicode parser 数据 with deterministic checks.", phase: "review",
    evidence: { workProduct: true, requirementsSettled: true, strongVerification: true, review: true },
    hostCapabilities: { delegation: { available: true, invocation: "direct", targets: models.DEFAULT_MODEL_POLICY.definition.allowedModels } } },
  { store: legacyStore, cwd: home, catalog, enforceLifecycleHooks: false, diskProbe: () => 20n * 1024n ** 3n });
  assert.equal(route.action, "delegate");
  // Older writers predate stage enrollment. The fixture knows the exact A
  // module that just executed; use the normal binding helper for that call.
  if (!store.db.prepare("SELECT 1 FROM runtime_stages WHERE route_id=?").get(route.routeId))
    store.transaction(() => isolation.bindRuntimeStage(store.db, context, route.routeId, originalCall));
  assert.equal(store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(route.routeId).generation, source.digest);
  isolation.finishRuntimeInvocation(store.db, originalCall); legacyStore.close(); legacyStore = null;
  const block = `legacy_delegation_block:${context.projectId}:${context.contextKey}`;
  store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(block, route.routeId);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'delegation_%' OR name IN ('routes','outcomes','runtime_tasks','runtime_stages')) ORDER BY name").all().map(row => row.name);
  const snapshot = () => JSON.stringify({ tables: tables.map(name => [name, store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
    legacy: store.db.prepare("SELECT * FROM meta WHERE key LIKE 'legacy_delegation_block:%' OR key IN ('model_policy:active','model_policy:activation-lineage') ORDER BY key").all() });
  const before = snapshot(), originalPolicy = api.readModelPolicy(store.db), definition = models.ECONOMY_MODEL_POLICY.definition;
  const pending = () => assert.equal(store.db.prepare("SELECT finalized_at FROM delegation_attempts WHERE route_id=?").get(route.routeId).finalized_at, null);
  const invoke = (name, run) => {
    const invocation = store.transaction(() => isolation.acquireRuntimeInvocation(store.db, context, { kind: `mcp:${name}`, generation: candidate.digest })).invocation;
    store.runtimeInvocation = invocation;
    try { return run(); } finally { isolation.finishRuntimeInvocation(store.db, invocation); store.runtimeInvocation = null; }
  };
  invoke("activate_model_policy", () => {
    const nativePrepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => sql === "SELECT * FROM runtime_epoch_publications WHERE candidate=?" ? { all: () => [] } : nativePrepare(sql);
    try { assert.equal(api.activateModelPolicy(store, { definition, expectedDigest: originalPolicy.digest }).reasonCode, "MODEL_POLICY_BUSY"); }
    finally { store.db.prepare = nativePrepare; }
    pending(); assert.equal(api.activateModelPolicy(store, { definition, expectedDigest: originalPolicy.digest }).activated, true); pending();
  });
  assert.equal(snapshot(), before, "activation preserves original unfinished lifecycle, bindings and legacy namespace");
  legacyStore = new A.RouterStore(); assert.equal(oldApi.readModelPolicy(legacyStore.db).digest, originalPolicy.digest); legacyStore.close(); legacyStore = null;
  invoke("rollback_model_policy", () => { pending(); assert.equal(api.rollbackModelPolicy(store, { expectedDigest: models.ECONOMY_MODEL_POLICY.digest }).digest, originalPolicy.digest); pending(); });
  assert.equal(snapshot(), before, "rollback preserves the same unfinished original work");
  legacyStore = new A.RouterStore(); assert.equal(oldApi.readModelPolicy(legacyStore.db).digest, originalPolicy.digest); legacyStore.close(); legacyStore = null;
  assert.equal(snapshot(), before);
  console.log(JSON.stringify({ passed: true, source: source.digest, candidate: candidate.digest,
    coverage: "isolated actual A router and B policy APIs with fixture-owned registered invocations",
    unfinishedActivation: true, unfinishedRollback: true, missingPublicationBlocked: true, lifecycleAndLegacyUnchanged: true, nativeLoggedInSmoke: false }));
} finally { legacyStore?.close(); store?.close(); rmSync(home, { recursive: true, force: true }); }
