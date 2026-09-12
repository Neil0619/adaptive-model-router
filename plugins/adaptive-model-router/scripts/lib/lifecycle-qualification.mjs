import { qualificationTargetMatches } from "./qualification-policy.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AppServerClient, resolveCodexCommand } from "./app-server.mjs";
import { canonicalJson, payloadHash } from "./io.mjs";
import { auditNativeLifecycleNoop, NATIVE_LIFECYCLE_CLI_VERSIONS, supportsNativeLifecycleHost } from "./native-lifecycle-audit.mjs";
import { activeRequalification, consumeRequalification } from "./qualification-retry.mjs";
import { verifyStageClosure } from "./stage-closure.mjs";

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOFS = new WeakMap();
const EVENTS = ["pre", "post", "start", "stop"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const key = (context) => `native_qualification:${context.projectId}:${context.contextKey}`;

export function runtimeSourceDigest(root = MODULE_ROOT) {
  const entries = ["hook.mjs", ...readdirSync(join(root, "scripts", "lib"))
    .filter((name) => name.endsWith(".mjs")).map((name) => `lib/${name}`)].sort();
  return payloadHash([
    ...entries.map((name) => [name, sha(readFileSync(join(root, "scripts", name)))]),
    ["model-policy.json", sha(readFileSync(join(root, "model-policy.json")))],
  ]);
}

export async function nativeQualificationHost() {
  if (!["darwin", "win32"].includes(process.platform)) throw new Error("native qualification platform is unproven");
  const command = await resolveCodexCommand();
  if (command.kind !== "direct") throw new Error("native qualification requires a directly verifiable executable");
  const path = realpathSync(command.path);
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 3_000, maxBuffer: 1024, windowsHide: true });
  const version = /^codex-cli (\S+)\s*$/u.exec(result.stdout || "")?.[1];
  if (result.error || result.status !== 0 || !supportsNativeLifecycleHost(process.platform, version)) throw new Error("native qualification build is unproven");
  return { platform: process.platform, arch: process.arch, cliVersion: version,
    executableDigest: sha(readFileSync(path)), executablePathDigest: payloadHash(path) };
}

export function lifecycleBinding(hooks, shellRoot, inventoryRoot, host, cwd, historicalRoots = []) {
  const runtimeDigest = runtimeSourceDigest();
  const taskCwdDigest = payloadHash(realpathSync(cwd));
  const directShellRoots = [...new Set([shellRoot, inventoryRoot].map((root) => payloadHash(realpathSync(root))))].sort();
  const shellRoots = [...new Set([shellRoot, inventoryRoot, ...historicalRoots].map((root) => payloadHash(realpathSync(root))))].sort();
  const hookSet = hooks.map((hook) => Object.fromEntries([
    "eventName", "handlerType", "command", "matcher", "timeoutSec", "statusMessage", "async",
    "source", "sourcePath", "pluginId", "currentHash", "enabled", "trustStatus",
  ].map((field) => [field, hook[field] ?? null])));
  return { digest: payloadHash({ host, hookSet, shellRoots, directShellRoots, runtimeDigest, taskCwdDigest }), runtimeDigest, taskCwdDigest,
    configurationDigest: payloadHash({ host, hookSet, taskCwdDigest }),
    shellRoots, directShellRoots, cliVersion: host.cliVersion };
}

function validBinding(binding) {
  return digest(binding?.digest) && digest(binding?.runtimeDigest) && digest(binding?.taskCwdDigest)
    && NATIVE_LIFECYCLE_CLI_VERSIONS.includes(binding.cliVersion)
    && Array.isArray(binding.shellRoots) && binding.shellRoots.length > 0
    && binding.shellRoots.length <= 6 && binding.shellRoots.every(digest)
    && (binding.directShellRoots === undefined || (Array.isArray(binding.directShellRoots)
      && binding.directShellRoots.length > 0 && binding.directShellRoots.length <= 2
      && binding.directShellRoots.every((root) => binding.shellRoots.includes(root))));
}

export function newTaskQualification(binding, routeId, requalification = null, passedRefresh = null) {
  if (!validBinding(binding)) return null;
  return { schema: 1, state: "pending", routeId, binding, hooks: {},
    ...(requalification ? { requalification } : {}),
    ...(passedRefresh ? { passedRefresh } : {}),
    marker: `NATIVE_ROUTER_NOOP_${randomBytes(12).toString("hex")}`, createdAt: new Date().toISOString() };
}

export function readTaskQualification(db, context) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key(context));
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    if (value.schema === 1 && validBinding(value.binding) && typeof value.routeId === "string"
      && ["pending", "passed", "failed"].includes(value.state)
      && /^NATIVE_ROUTER_NOOP_[a-f0-9]{24}$/u.test(value.marker)
      && value.hooks && typeof value.hooks === "object") return value;
  } catch { /* Invalid state must never look like a fresh task. */ }
  return { state: "invalid" };
}

function write(db, context, value) {
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(canonicalJson(value), key(context));
}

export function reserveTaskQualification(db, context, qualification, ticketHash) {
  if (qualification.passedRefresh) return consumePassedRefresh(db, context, qualification, ticketHash);
  if (qualification.requalification) return consumeRequalification(db, context,
    readTaskQualification(db, context), qualification, ticketHash);
  return db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING")
    .run(key(context), canonicalJson({ ...qualification, ticketHash })).changes === 1;
}

export function qualificationReadiness(db, context, binding) {
  const existing = readTaskQualification(db, context);
  if (!existing) return { ready: false, reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN", qualificationBinding: binding, binding };
  const requalification = activeRequalification(db, context, existing, binding);
  if (requalification) return { ready: false, reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN",
    qualificationBinding: binding, requalification, binding };
  const passedRefresh = passedQualificationRefresh(db, context, existing, binding);
  if (passedRefresh) return { ready: false, reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN",
    qualificationBinding: binding, passedRefresh, binding };
  if (existing.binding?.digest !== binding.digest) return { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH", binding };
  if (existing.state === "passed" && digest(existing.proof?.rawAuditDigest)) return { ready: true, reasonCode: null, binding };
  return { ready: false, reasonCode: "HOST_LIFECYCLE_QUALIFICATION_FAILED", binding };
}

function validPassedProof(value) {
  const proof = value?.proof;
  return value?.schema === 1 && value.state === "passed" && validBinding(value.binding) && !value.failure && digest(value.ticketHash)
    && Number.isFinite(Date.parse(value.completedAt)) && proof?.passed === true
    && proof.rawAuditAdapter === `codex-${value.binding.cliVersion}-no-work/1`
    && ["rawAuditDigest", "childDigest", "childTurnDigest", "rootTurnDigest", "toolUseDigest"]
      .every((field) => digest(proof[field]))
    && Number.isSafeInteger(proof.sourceBytes) && proof.sourceBytes > 0 && proof.sourceBytes <= 2 * 1024 * 1024
    && EVENTS.every((event) => value.hooks[event]?.runtimeDigest === value.binding.runtimeDigest
      && value.binding.shellRoots.includes(value.hooks[event].shellRoot));
}

function consistentPassedAttempt(attempt, context, value, route) {
  // Terminal attempts are bounded history, unlike the qualification and its
  // route/outcome. Their legitimate pruning must not revoke retained proof.
  if (!attempt) return true;
  return attempt.project_id === context.projectId && attempt.context_key === context.contextKey
    && Number.isFinite(Date.parse(attempt.finalized_at)) && attempt.outcome_recorded === 1 && attempt.outcome_status === "passed"
    && attempt.ticket_consumed === 1 && attempt.post_observed === 1 && attempt.stop_observed === 1
    && attempt.no_child === 0 && attempt.ambiguous === 0 && attempt.ticket_hash === null && attempt.context_package === null
    && attempt.model === route.model && attempt.effort === route.effort
    && attempt.agent_id === value.proof.childDigest
    && (attempt.early_agent_id === null || attempt.early_agent_id === attempt.agent_id)
    && typeof attempt.root_turn_id === "string" && sha(attempt.root_turn_id) === value.proof.rootTurnDigest
    && typeof attempt.tool_use_id === "string" && sha(attempt.tool_use_id) === value.proof.toolUseDigest
    && digest(attempt.dispatch_input_digest)
    && Number.isSafeInteger(attempt.transcript_bytes) && attempt.transcript_bytes > 0
    && (attempt.early_transcript_bytes === null || attempt.early_transcript_bytes === attempt.transcript_bytes);
}

function passedQualificationBasis(db, context, value) {
  if (!validPassedProof(value)) return null;
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(value.routeId, context.projectId, context.contextKey);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=? AND project_id=? AND context_key=?")
    .get(value.routeId, context.projectId, context.contextKey);
  if (route?.action !== "delegate" || route.verification_gate !== "structured-check"
    || route.reason_codes_json !== '["HOST_LIFECYCLE_QUALIFICATION"]'
    || !qualificationTargetMatches(db, value, route)
    || outcome?.status !== "passed" || outcome.gate !== "structured-check" || outcome.failure_type !== null
    || outcome.category !== route.category || outcome.escalations !== route.escalation_count) return null;
  const normalizedOutcome = { status: outcome.status, gate: outcome.gate, failureType: outcome.failure_type,
    retries: outcome.retries, retryBreakdown: { reasoning: outcome.retry_reasoning, environment: outcome.retry_environment,
      information: outcome.retry_information, tooling: outcome.retry_tooling }, escalations: outcome.escalations,
    userCorrection: outcome.user_correction === 1 };
  if (payloadHash(normalizedOutcome) !== outcome.payload_hash
    || !consistentPassedAttempt(db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(value.routeId), context, value, route)) return null;
  return payloadHash({ qualification: value, route, outcome });
}

// An open host task can keep separate parent and child Hook snapshots across
// an upgrade. The prior configured shell can first appear on a child after the
// next upgrade, even though the previous proof's child used an older shell.
// Retain explicitly bound parent/configured roots plus observed proof roots;
// never enumerate all cache paths. Readiness rechecks their current definitions.
export function provenQualificationShellRoots(db, context) {
  let value = readTaskQualification(db, context);
  const seen = new Set();
  const retained = new Set();
  for (let depth = 0; value && depth < 8; depth++) {
    if (!validBinding(value.binding)) return [];
    // Legacy bindings did not distinguish direct from historical roots. Keep
    // their bounded set through the next proof, which records those roles.
    for (const root of value.binding.directShellRoots || value.binding.shellRoots) retained.add(root);
    if (passedQualificationBasis(db, context, value)) return [...new Set([...retained, ...EVENTS.map((event) => value.hooks[event].shellRoot)])];
    const prior = value.passedRefresh?.priorRouteId || value.requalification?.priorRouteId;
    if (typeof prior !== "string" || seen.has(prior)) return [];
    seen.add(prior);
    try { value = JSON.parse(db.prepare("SELECT value FROM meta WHERE key=?").get(`native_qualification_archive:${prior}`)?.value); }
    catch { return []; }
    if (value?.routeId !== prior) return [];
  }
  return [];
}

function passedQualificationRefresh(db, context, previous, binding) {
  if (!validBinding(binding) || previous?.binding?.digest === binding.digest
    || previous?.binding?.taskCwdDigest !== binding.taskCwdDigest
    || db.prepare("SELECT 1 FROM delegation_attempts WHERE project_id=? AND context_key=? AND finalized_at IS NULL")
      .get(context.projectId, context.contextKey)
    || db.prepare("SELECT 1 FROM meta WHERE key=?").get(`legacy_delegation_block:${context.projectId}:${context.contextKey}`)
    || db.prepare("SELECT 1 FROM meta WHERE key=?").get(`native_qualification_archive:${previous?.routeId}`)) return null;
  const basisDigest = passedQualificationBasis(db, context, previous);
  return basisDigest ? { priorRouteId: previous.routeId, basisDigest, bindingDigest: payloadHash(binding) } : null;
}

// Admission calls this inside its route/ticket transaction. Refresh authorizes
// only a new no-tool proof; it neither copies success nor consumes failed-proof
// recovery authority. Re-read the full retained basis before replacing anything.
function consumePassedRefresh(db, context, next, ticketHash) {
  const previous = readTaskQualification(db, context);
  const refresh = passedQualificationRefresh(db, context, previous, next.binding);
  if (!refresh || payloadHash(refresh) !== payloadHash(next.passedRefresh)
    || next.requalification || next.state !== "pending" || next.proof !== undefined
    || Object.keys(next.hooks).length !== 0 || next.routeId === previous.routeId
    || next.marker === previous.marker || !digest(ticketHash) || ticketHash === previous.ticketHash) return false;
  const retained = db.prepare("SELECT value FROM meta WHERE key=?").get(key(context));
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)")
    .run(`native_qualification_archive:${previous.routeId}`, retained.value);
  write(db, context, { ...next, ticketHash });
  return true;
}

export function observeQualificationHook(db, context, routeId, event, shellRoot) {
  const value = readTaskQualification(db, context);
  if (value?.state !== "pending" || value.routeId !== routeId || !EVENTS.includes(event)) return;
  const observation = { runtimeDigest: runtimeSourceDigest(), shellRoot: payloadHash(realpathSync(shellRoot)) };
  if (observation.runtimeDigest !== value.binding.runtimeDigest || !value.binding.shellRoots.includes(observation.shellRoot)) {
    write(db, context, { ...value, state: "failed", failure: "HOST_HOOK_SET_MISMATCH", rejectedHook: { event, ...observation } });
    return;
  }
  write(db, context, { ...value, hooks: { ...value.hooks, [event]: observation } });
}

function requireFact(value) {
  if (!value) throw new Error("native qualification evidence is incomplete or inconsistent");
}

export function nativeTaskWorkingDirectory(thread, { contextId, store, context }) {
  requireFact(thread?.id === contextId && typeof thread.cwd === "string");
  const cwd = realpathSync(thread.cwd);
  const observed = store.context({ cwd, contextId, authoritative: true, create: false });
  requireFact(observed.projectId === context.projectId && observed.contextKey === context.contextKey);
  return cwd;
}

async function nativeSnapshot(parentId, attempt) {
  const client = new AppServerClient({ timeoutMs: 20_000 });
  try {
    await client.start();
    const parent = (await client.request("thread/read", { threadId: parentId, includeTurns: true })).thread;
    const turn = parent.turns.find((entry) => entry.id === attempt.root_turn_id);
    const starts = turn?.items.filter((item) => item.type === "subAgentActivity" && item.kind === "started"
      && sha(String(item.agentThreadId)) === attempt.agent_id) || [];
    requireFact(starts.length === 1);
    const child = (await client.request("thread/read", { threadId: starts[0].agentThreadId, includeTurns: true })).thread;
    return { parent, child };
  } finally { client.close(); }
}

function verifySnapshot({ parent, child }, attempt, value, input, store, context, auditOptions) {
  const persistedRoute = store.db.prepare("SELECT * FROM routes WHERE route_id=?").get(attempt.route_id);
  requireFact(qualificationTargetMatches(store.db, value, persistedRoute));
  const cwd = nativeTaskWorkingDirectory(parent, { contextId: input.contextId, store, context });
  requireFact(payloadHash(cwd) === value.binding.taskCwdDigest);
  requireFact(child.cliVersion === value.binding.cliVersion && realpathSync(child.cwd) === cwd);
  const turn = parent.turns.find((entry) => entry.id === attempt.root_turn_id);
  requireFact(turn?.itemsView === "full");
  const activities = turn.items.filter((item) => item.type === "subAgentActivity" && item.agentThreadId === child.id);
  const starts = activities.filter((item) => item.kind === "started");
  const stops = activities.filter((item) => item.kind === "completed");
  requireFact(activities.length === 2 && starts.length === 1 && stops.length === 1);
  requireFact(starts[0].id === attempt.tool_use_id && sha(child.id) === attempt.agent_id);
  const taskName = starts[0].agentPath?.slice(6);
  requireFact(starts[0].agentPath === `/root/${taskName}` && /^router_[a-f0-9]{32}$/u.test(taskName));
  const carrierActivities = turn.items.filter((item) => item.type === "subAgentActivity"
    && item.agentPath === starts[0].agentPath);
  requireFact(carrierActivities.length === 2 && carrierActivities.every((item) => item.agentThreadId === child.id));
  requireFact(sha(taskName.slice(7)) === value.ticketHash && stops[0].agentPath === starts[0].agentPath);
  requireFact(stops[0].id === `subagent-completed-${child.turns[0]?.id}`);
  const audit = auditNativeLifecycleNoop({ child, parentId: input.contextId, taskName,
    target: { model: attempt.model, effort: attempt.effort }, marker: value.marker }, auditOptions);
  requireFact(audit.passed);
  return { ...audit, childDigest: sha(child.id), childTurnDigest: sha(child.turns[0].id),
    rootTurnDigest: sha(turn.id), toolUseDigest: sha(starts[0].id) };
}

// Operator recovery may establish only that a failed, completed qualification
// did no work. This does not mint a passed proof or enable ordinary delegation.
export async function auditFailedQualificationNoop(input, { store, cwd, readNative = nativeSnapshot, auditOptions } = {}) {
  const context = store.context({ cwd, contextId: input.contextId, create: false });
  const value = readTaskQualification(store.db, context);
  const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(input.routeId);
  requireFact(value?.state === "failed" && value.proof === null && value.routeId === input.routeId);
  requireFact(attempt?.finalized_at && attempt.ticket_consumed === 1 && attempt.post_observed === 1
    && attempt.stop_observed === 1 && attempt.no_child === 0 && attempt.ambiguous === 0 && attempt.outcome_recorded === 1);
  const before = payloadHash({ value, attempt });
  const first = verifySnapshot(await readNative(input.contextId, attempt), attempt, value, input, store, context, auditOptions);
  const second = verifySnapshot(await readNative(input.contextId, attempt), attempt, value, input, store, context, auditOptions);
  requireFact(payloadHash(first) === payloadHash(second));
  requireFact(before === payloadHash({ value: readTaskQualification(store.db, context),
    attempt: store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(input.routeId) }));
  return first;
}

// Only this source-owned verifier mints the in-process token consumed by the
// outcome transaction. No public tool accepts a proof, reader, binding or flag.
export async function prepareQualificationOutcome(input, {
  store, cwd, inspectBinding, readNative = nativeSnapshot, auditOptions,
} = {}) {
  const context = store.context({ cwd, contextId: input.contextId });
  const value = readTaskQualification(store.db, context);
  if (!value || value.routeId !== input.routeId || value.state === "passed") return null;
  // Managed Stop records a turn/result fact; only completed native evidence
  // projects that fact into the legacy attempt. Do this before binding the
  // qualification proof to the attempt. Pending work is recoverable and must
  // not turn an otherwise valid qualification into a permanently failed audit.
  store.transaction(() => verifyStageClosure(store.db, context, input.routeId, input.closureToken));
  const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(input.routeId);
  try {
    requireFact(attempt?.ticket_consumed === 1);
    let proof = null;
    if (input.status === "passed") {
      requireFact(value.state === "pending" && attempt.post_observed === 1 && attempt.stop_observed === 1
        && attempt.no_child === 0 && attempt.ambiguous === 0 && attempt.outcome_recorded === 0
        && Number.isSafeInteger(attempt.transcript_bytes));
      requireFact(EVENTS.every((event) => value.hooks[event]?.runtimeDigest === value.binding.runtimeDigest
        && value.binding.shellRoots.includes(value.hooks[event].shellRoot)));
      const before = await inspectBinding();
      requireFact(before.binding?.digest === value.binding.digest);
      proof = verifySnapshot(await readNative(input.contextId, attempt), attempt, value, input, store, context, auditOptions);
      const repeated = verifySnapshot(await readNative(input.contextId, attempt), attempt, value, input, store, context, auditOptions);
      requireFact(payloadHash(proof) === payloadHash(repeated));
      requireFact((await inspectBinding()).binding?.digest === value.binding.digest);
    }
    const token = Object.freeze({});
    PROOFS.set(token, { contextKey: key(context), inputDigest: payloadHash(input),
      stateDigest: payloadHash(value), attemptDigest: payloadHash(attempt), proof });
    return token;
  } catch {
    store.transaction(() => {
      const latest = readTaskQualification(store.db, context);
      if (latest?.routeId === input.routeId && latest.state === "pending") {
        write(store.db, context, { ...latest, state: "failed", failure: "NATIVE_QUALIFICATION_EVIDENCE_UNPROVEN" });
      }
    });
    throw new Error("native qualification verification failed; ordinary delegation remains disabled");
  }
}

export function consumeQualificationOutcome(db, context, routeId, input, token) {
  const value = readTaskQualification(db, context);
  if (!value || value.routeId !== routeId) return false;
  const proof = token && PROOFS.get(token);
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(routeId);
  requireFact(proof?.contextKey === key(context) && proof.inputDigest === payloadHash(input)
    && proof.stateDigest === payloadHash(value) && proof.attemptDigest === payloadHash(attempt));
  PROOFS.delete(token);
  write(db, context, { ...value, state: input.status === "passed" ? "passed" : "failed",
    proof: proof.proof, completedAt: new Date().toISOString() });
  return true;
}
