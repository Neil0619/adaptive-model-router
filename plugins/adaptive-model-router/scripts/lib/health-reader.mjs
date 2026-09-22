import { existsSync, readFileSync } from "node:fs";
import { databasePath, opaqueId, projectIdentityMaterial } from "./context.mjs";
import { observationPath, observationGapPath, OBSERVATION_RETENTION, parseStoredObservation } from "./observability.mjs";
import { payloadHash } from "./io.mjs";
import { reservationInventory } from "./reservation-ledger.mjs";
import { openReadOnlySnapshot } from "./read-only-snapshot.mjs";

const table = (db, name) => Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function checkReadableSchema(db, kind) {
  if (!db) return;
  if (kind === "router" && table(db, "delegation_attempts")) {
    // These are dependencies of enabled queries, not a migration requirement
    // for all old stores. Absent unrelated feature tables remain supported.
    if (!table(db, "meta") || (table(db, "delegation_maintenance") && table(db, "delegation_children") && !table(db, "routes")))
      throw new Error("Router health query dependency is unavailable");
  }
  const schemas = kind === "router" ? {
    meta: "key value", routes: `route_id project_id context_key created_at${table(db, "outcomes") ? " action reason_codes_json" : ""}`,
    outcomes: "route_id status", outcome_verification_evidence: "route_id",
    delegation_attempts: "route_id project_id context_key finalized_at created_at",
    delegation_maintenance: "route_id state start_revision", delegation_children: "route_id project_id context_key created_at state",
    runtime_invocations: "project_id context_key state", runtime_call_receipts: "project_id context_key state",
    runtime_defaults: "current_digest", runtime_generations: "digest record",
    runtime_tasks: "project_id context_key generation candidate", runtime_stages: "project_id context_key generation",
    retention_coverage: "project_id kind pruned_count pruned_through",
  } : { events: "seq observed_at project_key context_key payload_json", coverage: "id started_at pruned_age pruned_capacity pruned_through last_written_at" };
  for (const [name, columns] of Object.entries(schemas)) {
    if (table(db, name)) db.prepare(`SELECT ${columns.split(" ").join(",")} FROM ${name} LIMIT 0`).all();
  }
}
function instant(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`health ${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
function cursorValue(value) {
  if (!value) return null;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const v = JSON.parse(Buffer.from(value, "base64url").toString());
    if (v.schema !== 1 || !/^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(v.after)
      || !/^[a-f0-9]{64}$/u.test(v.queryDigest)) throw new Error();
    return v;
  } catch { throw new Error("health cursor is invalid"); }
}

/** No RouterStore, migrations, enrollment, recovery, GC, or salt creation.
 * Two independent read snapshots are reported as observations, never an
 * atomic admission/closure proof. Native release checks never alter state. */
export function readHealth({ mainPath = databasePath(), from, to, scope = "project", cwd = process.cwd(), limit = 50, cursor, now = Date.now() } = {}) {
  if (!["project", "local"].includes(scope)) throw new Error("health scope must be project or local");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("health limit must be between 1 and 200");
  const previous = cursorValue(cursor);
  from = instant(from || previous?.from || new Date(now - 7 * 86_400_000).toISOString(), "from");
  to = instant(to || previous?.to || new Date(now).toISOString(), "to");
  if (from >= to) throw new Error("health from must precede to");
  let main, observations;
  const snapshots = [], unavailable = {};
  const snapshot = (path, kind) => {
    try { const value = openReadOnlySnapshot(path); if (value) snapshots.push(value); checkReadableSchema(value?.db, kind); return value?.db || null; }
    catch { unavailable[kind] = "unavailable_or_corrupt"; return null; }
  };
  try {
    main = snapshot(mainPath, "router");
    observations = snapshot(observationPath(mainPath), "observations");
    main?.exec("BEGIN"); observations?.exec("BEGIN");
    const salt = table(main, "meta") ? main.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value : null;
    const project = scope === "project" && salt ? opaqueId(salt, "project", projectIdentityMaterial(cwd)) : null;
    const queryDigest = payloadHash({ from, to, scope, project });
    if (previous && queryDigest !== previous.queryDigest) throw new Error("health cursor does not belong to this query");
    const scoped = (column) => scope === "local" ? { sql: "", args: [] } : { sql: ` AND ${column}=?`, args: [project || "unavailable"] };
    const tasks = new Map();
    const task = (p, c) => {
      const key = `${p}:${c}`;
      if (!tasks.has(key)) tasks.set(key, { key, projectKey: p, contextKey: c, routes: { delegate: 0, continue: 0, ask_user: 0 },
        operations: {}, fallback: { count: 0, firstAt: null, lastAt: null }, pendingResponsibilities: [],
        runtime: { taskBinding: null, stageOwners: [], observedExecutions: [], historicalExecution: "unknown" },
        taskOrigin: "unknown", originEvidence: "not_recorded", executionOrigins: [], verificationEvidence: { recorded: 0, notRecorded: 0 } });
      return tasks.get(key);
    };
    const rs = scoped("r.project_id"), es = scoped("project_key");
    let routes = [], eventRows = [], invalidObservationRecords = 0;
    if (table(main, "routes") && table(main, "outcomes")) {
      routes = main.prepare(`SELECT r.route_id,r.project_id,r.context_key,r.action,r.reason_codes_json,r.created_at,
        o.status AS outcome_status FROM routes r LEFT JOIN outcomes o ON o.route_id=r.route_id
        WHERE r.created_at>=? AND r.created_at<?${rs.sql} ORDER BY r.created_at,r.route_id`).all(from, to, ...rs.args);
      for (const r of routes) {
        const t = task(r.project_id, r.context_key);
        t.routes[r.action] = (t.routes[r.action] || 0) + 1;
        if (r.action === "delegate" && r.outcome_status === "passed") t.lastPassedDelegateAt = r.created_at;
        if (r.action === "continue" && /UNAVAILABLE|UNPROVEN|REQUIRED|MISMATCH|PENDING|LIMIT|DISK/u.test(r.reason_codes_json)) {
          t.fallback.count++; t.fallback.firstAt ||= r.created_at; t.fallback.lastAt = r.created_at;
        }
        if (r.outcome_status) {
          const recorded = table(main, "outcome_verification_evidence") && main.prepare("SELECT 1 FROM outcome_verification_evidence WHERE route_id=?").get(r.route_id);
          t.verificationEvidence[recorded ? "recorded" : "notRecorded"]++;
        }
      }
    }
    const operations = {}, hookProblems = {}, transportProblems = {}, detailProblems = {}, unowned = {}, diagnosticPruning = {};
    if (table(observations, "events")) {
      for (const row of observations.prepare(`SELECT payload_json,observed_at,project_key,context_key FROM events WHERE observed_at>=? AND observed_at<?${es.sql} ORDER BY seq`).all(from, to, ...es.args)) {
        const e = parseStoredObservation(row.payload_json);
        if (!e || e.observedAt !== row.observed_at || e.projectKey !== row.project_key || e.contextKey !== row.context_key) { invalidObservationRecords++; continue; }
        eventRows.push(e);
        const trustedIdentity = ["native_dispatch", "native_hook"].includes(e.identitySource);
        const t = trustedIdentity && e.projectKey && e.contextKey ? task(e.projectKey, e.contextKey) : null;
        if (["mcp", "service"].includes(e.component) && e.event === "finished") {
          operations[e.operation] = (operations[e.operation] || 0) + 1;
          const counts = t?.operations || unowned;
          counts[e.operation] = (counts[e.operation] || 0) + 1;
        }
        if (["hook", "launcher"].includes(e.component) && e.errorCode) hookProblems[e.errorCode] = (hookProblems[e.errorCode] || 0) + 1;
        if (["bridge", "launcher"].includes(e.component) && e.event === "finished" && ["failed", "rejected", "degraded"].includes(e.operation))
          transportProblems[e.component] = (transportProblems[e.component] || 0) + 1;
        if (e.event === "detail" && ["failed", "rejected", "degraded"].includes(e.operation))
          detailProblems[e.errorCode || "UNKNOWN_DETAIL_FAILURE"] = (detailProblems[e.errorCode || "UNKNOWN_DETAIL_FAILURE"] || 0) + 1;
        if (["pruned", "truncated"].includes(e.event) && e.evidenceKind) diagnosticPruning[e.evidenceKind] = (diagnosticPruning[e.evidenceKind] || 0) + (e.count || 0);
        if (t && e.originSource === "native_metadata") {
          if (["interactive_root", "background_suggestion"].includes(e.taskOrigin)) {
            t.taskOrigin = e.taskOrigin; t.originEvidence = "native_metadata";
          }
          const executionOrigin = e.executionOrigin !== "unknown" ? e.executionOrigin : e.taskOrigin;
          if (executionOrigin !== "unknown" && !t.executionOrigins.includes(executionOrigin)) t.executionOrigins.push(executionOrigin);
        }
        if (t && e.runtimeState === "entered" && ["mcp", "service", "hook"].includes(e.component)
          && e.runtimeDigest && !t.runtime.observedExecutions.some((r) => r.digest === e.runtimeDigest))
          t.runtime.observedExecutions.push({ digest: e.runtimeDigest, version: e.runtimeVersion, source: "execution_observation" });
      }
    }
    let charged = 0, released = 0, unverifiedRelease = 0;
    // Outstanding responsibility is current all-time state, not restricted to
    // the request window. Accounting release never substitutes for closure.
    if (table(main, "delegation_attempts")) {
      const deadline = Date.now() + 2000;
      const inventory = table(main, "delegation_maintenance") && table(main, "delegation_children")
        ? reservationInventory(main, { deadline })
        : { pending: main.prepare("SELECT * FROM delegation_attempts WHERE finalized_at IS NULL").all(), released: [] };
      const releasedIds = new Set(inventory.released.map((a) => a.route_id));
      for (const a of [...inventory.pending, ...inventory.released]) {
        if (scope !== "local" && a.project_id !== project) continue;
        const t = task(a.project_id, a.context_key);
        const receiptPresent = Boolean(main.prepare("SELECT 1 FROM meta WHERE key=?").get(`global_reservation_release:${a.route_id}`));
        const verifiedRelease = releasedIds.has(a.route_id);
        const accounting = verifiedRelease ? "released" : receiptPresent ? "release_unverified" : "charged";
        if (verifiedRelease) released++; else if (receiptPresent) unverifiedRelease++; else charged++;
        t.pendingResponsibilities.push({ routeId: a.route_id, since: a.created_at, accounting,
          kind: a.maintenance_only || a.finalized_at ? "maintenance" : "delegation",
          missing: a.maintenance_only || a.finalized_at ? ["maintenance_verification"] : [!a.ticket_consumed && "dispatch", !a.post_observed && "post", !a.agent_id && !a.no_child && "child_identity", !a.stop_observed && !a.no_child && "stop", !a.outcome_recorded && "outcome"].filter(Boolean),
          ambiguous: a.ambiguous === 1 });
      }
    }
    const runtimeResponsibilities = { activeInvocations: 0, unknownInvocations: 0, pendingCallReceipts: 0 };
    for (const [name, condition, label] of [["runtime_invocations", "state='active'", "activeInvocations"],
      ["runtime_invocations", "state='unknown'", "unknownInvocations"], ["runtime_call_receipts", "state='pending'", "pendingCallReceipts"]]) {
      if (!table(main, name)) continue;
      const where = scoped("project_id");
      for (const row of main.prepare(`SELECT project_id,context_key,count(*) AS n FROM ${name} WHERE ${condition}${where.sql} GROUP BY project_id,context_key`).all(...where.args)) {
        const t = task(row.project_id, row.context_key);
        t.runtimeResponsibilities ||= {};
        t.runtimeResponsibilities[label] = row.n;
        runtimeResponsibilities[label] += row.n;
      }
    }
    const currentRuntime = table(main, "runtime_defaults") ? main.prepare("SELECT current_digest FROM runtime_defaults LIMIT 1").get()?.current_digest : null;
    const runtimeVersion = (digest) => {
      if (!table(main, "runtime_generations")) return null;
      try { return JSON.parse(main.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(digest)?.record).descriptor.runtimeVersion || null; } catch { return null; }
    };
    for (const t of tasks.values()) {
      if (table(main, "runtime_tasks")) {
        const b = main.prepare("SELECT generation,candidate FROM runtime_tasks WHERE project_id=? AND context_key=?").get(t.projectKey, t.contextKey);
        if (b) t.runtime.taskBinding = { digest: b.generation, version: runtimeVersion(b.generation), candidate: b.candidate, differsFromDefault: currentRuntime ? b.generation !== currentRuntime : null, provesHistoricalExecution: false };
      }
      if (table(main, "runtime_stages")) t.runtime.stageOwners = main.prepare("SELECT DISTINCT generation AS digest FROM runtime_stages WHERE project_id=? AND context_key=?").all(t.projectKey, t.contextKey);
    }
    const coverage = table(observations, "coverage") ? observations.prepare("SELECT * FROM coverage WHERE id=1").get() : null;
    const bounds = table(observations, "events") ? observations.prepare("SELECT min(observed_at) AS first,max(observed_at) AS last FROM events").get() : null;
    const observedRoutes = new Set(eventRows.filter((e) => e.event === "finished" && ["mcp", "service"].includes(e.component) && e.routeId).map((e) => e.routeId));
    const unobservedRoutes = routes.filter((r) => !observedRoutes.has(r.route_id)).length;
    let gap = null;
    if (existsSync(observationGapPath(mainPath))) {
      try { const g = JSON.parse(readFileSync(observationGapPath(mainPath), "utf8")); gap = { state: "incomplete", lastDropAt: instant(g.lastDropAt, "gap"), droppedCount: "at_least_one" }; }
      catch { gap = { state: "malformed" }; }
    }
    const prunedWindow = coverage?.pruned_through && coverage.pruned_through >= from;
    let incomplete = !coverage || coverage.started_at > from || ((coverage.pruned_capacity > 0 || coverage.pruned_age > 0) && prunedWindow)
      || Boolean(gap) || unobservedRoutes > 0 || invalidObservationRecords > 0 || Object.keys(diagnosticPruning).length > 0 || Object.keys(unavailable).length > 0;
    const allTasks = [...tasks.values()].sort((a, b) => a.key.localeCompare(b.key));
    const page = allTasks.filter((t) => !previous || t.key > previous.after).slice(0, limit + 1);
    const hasMore = page.length > limit; page.length = Math.min(page.length, limit);
    const integrity = (db) => !db ? "absent" : Object.values(db.prepare("PRAGMA quick_check(1)").get())[0] === "ok" ? "ok" : "failed";
    const prunes = table(main, "retention_coverage") ? main.prepare(`SELECT kind,sum(pruned_count) AS prunedCount,max(pruned_through) AS prunedNoLaterThan FROM retention_coverage WHERE 1=1${scoped("project_id").sql} GROUP BY kind`).all(...scoped("project_id").args) : [];
    if (prunes.some((p) => p.prunedCount > 0 && (!p.prunedNoLaterThan || p.prunedNoLaterThan >= from))) incomplete = true;
    return {
      schemaVersion: 1, readOnly: true, window: { from, to, endExclusive: true }, scope,
      snapshot: { readAt: new Date(now).toISOString(), atomicAcrossStores: false, pendingResponsibilitiesScope: "current_all_time" },
      integrity: { router: unavailable.router || integrity(main), observations: unavailable.observations || (invalidObservationRecords ? "partial" : integrity(observations)) },
      operationHealth: { state: (operations.failed || operations.rejected || operations.degraded || Object.keys(hookProblems).length || Object.keys(transportProblems).length || Object.keys(detailProblems).length || charged || released || unverifiedRelease || runtimeResponsibilities.unknownInvocations) ? "attention"
          : runtimeResponsibilities.activeInvocations || runtimeResponsibilities.pendingCallReceipts ? "operations_pending" : incomplete ? "unknown" : "no_observed_errors",
        toolCalls: operations, hookProblems, transportProblems, detailProblems, unattributedToolCalls: unowned,
        runtimeResponsibilities,
        reservations: { charged, releasedButUnfinalized: released, releaseUnverified: unverifiedRelease } },
      evidenceCoverage: { state: incomplete ? "partial" : "observed_window", absenceProvesNoErrors: false,
        collectionStartedAt: coverage?.started_at || null, firstAvailableAt: bounds?.first || null, lastAvailableAt: bounds?.last || null,
        retention: OBSERVATION_RETENTION, prunedAge: coverage?.pruned_age ?? null, prunedCapacity: coverage?.pruned_capacity ?? null,
        prunedThrough: coverage?.pruned_through || null, gap, acceptedRoutesWithoutObservation: unobservedRoutes, invalidObservationRecords,
        historicalPruning: prunes, diagnosticPruning, oldRuntimeCoverage: "unrecorded_is_unknown", verificationEvidenceAuthority: "caller_supplied" },
      totalTasks: allTasks.length, tasks: page.map(({ key: _key, ...value }) => value),
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ schema: 1, from, to, queryDigest, after: page.at(-1).key })).toString("base64url") : null,
    };
  } finally {
    for (const value of snapshots) value.close();
  }
}
