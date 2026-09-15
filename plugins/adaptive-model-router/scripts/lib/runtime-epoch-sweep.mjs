import { AppServerClient } from "./app-server.mjs";
import { inspectLifecycleHookReadiness } from "./hook-readiness.mjs";
import { runtimeTask, runtimeGeneration } from "./runtime-isolation.mjs";
import { readTaskQualification, prepareHistoricalQualificationAdoption } from "./lifecycle-qualification.mjs";
import { prepareHostEpochHandover, commitHostEpochHandover, epochAdmissionState, qualifyHostEpochPublication, publishHostEpoch } from "./runtime-epoch.mjs";
import { ensureHostEpochSchema } from "./host-epoch-storage.mjs";
import { payloadHash } from "./io.mjs";

// Frozen v1 writers stored a task-scoped qualification without a generation
// suffix. Absence of the newer key must not discard that original proof (or a
// failed/invalid responsibility). This is discovery only; adoption still
// rechecks the original route, outcome, native dispatch and complete raw child.
export function sourceTaskQualification(db, context, generation) {
  const scoped = readTaskQualification(db, { ...context, runtimeDigest: generation });
  if (scoped) return { qualification: scoped, sourceGeneration: generation };
  return { qualification: readTaskQualification(db, { ...context, runtimeDigest: undefined }), sourceGeneration: null };
}

// The installer/coordinator runs this outside the target task. It discovers
// native task addresses from thread/list; opaque Router context keys never get
// reverse-guessed. Dormant tasks are retried after their first real Hook enrolls
// them. A missing preassignment native entry attestation leaves A untouched.
export async function sweepHostCompatibilityEpoch({ store, candidate, shellRoot, maxTasks = 64, cursor = null,
  client = new AppServerClient({ timeoutMs: 20_000 }), inspect = inspectLifecycleHookReadiness } = {}) {
  ensureHostEpochSchema(store.db);
  const results = [];
  try {
    await client.start();
    let scanned = 0;
    do {
      const page = await client.request("thread/list", { limit: Math.min(64, maxTasks - scanned), ...(cursor ? { cursor } : {}) });
      for (const listed of page.data || []) {
        if (scanned++ >= maxTasks) break;
        if (listed.source?.subAgent || listed.parentThreadId) continue;
        const result = { contextDigest: payloadHash(listed.id), state: "checking" };
        try {
          const parent = (await client.request("thread/read", { threadId: listed.id, includeTurns: true })).thread;
          const context = store.context({ cwd: parent.cwd, contextId: parent.id, create: false });
          const task = runtimeTask(store.db, context);
          if (!task) { result.reason = "task_not_observed_by_v2_dispatch_yet"; results.push(result); continue; }
          if (task.generation === candidate) {
            Object.assign(result, epochAdmissionState(store.db, context));
            result.state = result.ready ? "active" : "checking"; results.push(result); continue;
          }
          // Fail before costly whole-file/adoption reads when exact native
          // entry evidence cannot be produced by this frozen task's shell.
          const entry = store.db.prepare(`SELECT 1 FROM runtime_epoch_native_entries e
            JOIN runtime_epoch_completed_invocations c ON c.invocation_id=e.invocation_id
            WHERE e.project_id=? AND e.context_key=? AND e.subject='task' AND e.generation=?`)
            .get(context.projectId, context.contextKey, task.generation);
          if (!entry) { result.reason = "native_entry_attestation_missing; native task entry reload required"; results.push(result); continue; }
          const target = runtimeGeneration(store.db, candidate);
          const targetContext = { ...context, runtimeDigest: candidate };
          const inspectBinding = () => inspect({ store, context: targetContext, contextId: parent.id, cwd: parent.cwd,
            pluginRoot: shellRoot, historicalAdoption: false });
          const readiness = await inspectBinding();
          if (!readiness.binding) throw new Error(readiness.reasonCode || "current_Hook_binding_missing");
          const turnId = parent.turns.at(-1)?.id;
          const { qualification: prior, sourceGeneration } = sourceTaskQualification(store.db, context, task.generation);
          let adoptionToken = null;
          if (prior?.state === "passed") adoptionToken = await prepareHistoricalQualificationAdoption({
            contextId: parent.id, routeId: prior.routeId, turnId, generation: target.digest,
          }, { store, cwd: parent.cwd, sourceGeneration, binding: readiness.binding, inspectBinding });
          else if (prior) throw new Error("historical_qualification_requires_its_existing_reconciliation");
          const token = await prepareHostEpochHandover(store, { contextId: parent.id, cwd: parent.cwd, turnId,
            transcriptPath: parent.path }, { candidate, adoptionToken, shellRoot, inspect });
          Object.assign(result, commitHostEpochHandover(store, token));
        } catch (error) {
          // Filesystem/RPC exceptions can contain native paths or message text.
          // Keep only our bounded reason vocabulary and ordinary OS error codes.
          result.reason = /^Host compatibility epoch blocked: [a-zA-Z0-9_:-]+$/u.test(error.message || "")
            || /^(?:HOST_[A-Z_]+|historical_qualification_requires_its_existing_reconciliation)$/u.test(error.message || "")
            ? error.message : `native_evidence_unavailable:${/^[A-Z0-9_]+$/u.test(error.code || "") ? error.code : "unverified"}`;
        }
        results.push(result);
      }
      cursor = page.nextCursor;
    } while (cursor && scanned < maxTasks);
    return { schema: "runtime-epoch-sweep/1", candidate, tasks: results,
      complete: results.length > 0 && !cursor && results.every((result) => result.state === "active"), nextCursor: cursor || null };
  } finally { client.close(); }
}

// The owner keeps this handle alive across target-task restarts. No host task is
// interrupted or model changed; each pass waits for actual native quiescence.
export function startHostCompatibilityEpochSweep(options, { intervalMs = 5_000, onChange = () => {} } = {}) {
  let stopped = false, timer = null, wake = null;
  const done = (async () => {
    let previous = null, cursor = null;
    while (!stopped) {
      const value = await sweepHostCompatibilityEpoch({ ...options, cursor });
      cursor = value.nextCursor;
      const serialized = JSON.stringify(value);
      if (serialized !== previous) { await onChange(value); previous = serialized; }
      if (stopped) break;
      await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
    }
  })();
  return { done, stop() { stopped = true; clearTimeout(timer); wake?.(); } };
}

// Controlled-install integration: verification, publication and a first bounded
// native discovery pass are one operation. This does not install a native shell,
// retire old task snapshots or prove their reload. Those host operations remain
// an explicit installer gap; even a completed discovered-task sweep cannot
// certify the whole installation or adopt a retained v1 executor.
export async function activateHostCompatibilityEpoch({ store, source, candidate, shellRoot, ...sweepOptions }) {
  const publication = publishHostEpoch(store, qualifyHostEpochPublication(source, candidate));
  const sweep = await sweepHostCompatibilityEpoch({ store, candidate: candidate.digest, shellRoot, ...sweepOptions });
  return { schema: "runtime-epoch-activation/1", publication, sweep,
    scope: "discovered_v2_tasks_with_actual_new_dispatcher_entry", complete: sweep.complete,
    installationComplete: false, nativeRegistration: "not_performed",
    remainingHostBoundary: "native_old_entry_retirement_and_task_reload_unproven; retained_v1_execution_unsupported",
    nextAction: sweep.complete ? null : "native_registration_and_verified_task_entry_required_before_watch_can_progress" };
}
