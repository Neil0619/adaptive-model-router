import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import {
  CONTEXT_PACKAGE_BYTE_LIMIT,
  claimDelegationSubagent,
  consumeDelegationTicket,
  inspectManagedSubagent,
  observeAgentResult,
  observeSubagentStop,
} from "../scripts/lib/delegation-gate.mjs";
import { readThreadSpawnIdentity } from "../scripts/lib/subagent-session.mjs";
import {
  CATALOG,
  completeNoChildRoute,
  observeNoChildRoute,
  routeInput,
  temporaryProject,
  withRouterEnvironment,
} from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(pluginRoot, "scripts", "hook.mjs");
const workerPath = join(pluginRoot, "test", "concurrency-worker.mjs");
const ampleDisk = () => 16n * 1024n * 1024n * 1024n;

async function writeChildTranscript(path, {
  parentId,
  childId,
  taskName,
  cwd,
  body = "",
}) {
  const agentPath = `/root/${taskName}`;
  const entry = {
    timestamp: "2026-09-02T00:00:00.000Z",
    type: "session_meta",
    payload: {
      session_id: parentId,
      id: childId,
      parent_thread_id: parentId,
      cwd,
      agent_path: agentPath,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: 1,
            agent_path: agentPath,
          },
        },
      },
    },
  };
  const content = `${JSON.stringify(entry)}\n${body}`;
  await writeFile(path, content, "utf8");
  return Buffer.byteLength(content);
}

test("Agent lifecycle hook matchers include Codex flattened collaboration spawn names", async () => {
  const hooks = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  for (const event of ["PreToolUse", "PostToolUse"]) {
    const matcher = new RegExp(hooks.hooks[event][0].matcher);
    assert.equal(matcher.test("Agent"), true, `${event} must retain the documented Agent alias`);
    assert.equal(matcher.test("spawn_agent"), true, `${event} must match the canonical live tool name`);
    assert.equal(matcher.test("collaborationspawn_agent"), true, `${event} must match the Codex 0.152 flattened namespace`);
    assert.equal(matcher.test("collaboration.spawn_agent"), false, `${event} must not assume a namespace separator`);
    assert.equal(matcher.test("send_message"), false, `${event} must not affect unrelated collaboration tools`);
  }
});

test("subagent session identity treats hook session_id as the parent task", async () => {
  const project = await temporaryProject("adaptive subagent identity ");
  try {
    const parentId = "parent-task";
    const childId = "child-task";
    const taskName = `router_${"a".repeat(32)}`;
    const transcript = join(project.root, "child-session.jsonl");
    await writeChildTranscript(transcript, {
      parentId,
      childId,
      taskName,
      cwd: project.root,
    });

    const accepted = readThreadSpawnIdentity({
      cwd: project.root,
      session_id: parentId,
      agent_id: childId,
      transcript_path: transcript,
    });
    assert.equal(accepted?.parentContextId, parentId);
    assert.equal(accepted?.childId, childId);
    assert.equal(accepted?.taskName, taskName);

    assert.equal(readThreadSpawnIdentity({
      cwd: project.root,
      session_id: childId,
      agent_id: childId,
      transcript_path: transcript,
    }), null);
  } finally {
    await project.cleanup();
  }
});

test("a Router-marked child observed before ticket consumption enters reconciliation", async () => {
  const project = await temporaryProject("adaptive predispatch child reconciliation ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const contextId = "predispatch-child";
        const delegated = await routeStage(routeInput({ contextId }), {
          store,
          cwd: project.root,
          catalog: CATALOG,
          diskProbe: ampleDisk,
        });
        assert.equal(delegated.action, "delegate");
        const context = store.context({ cwd: project.root, contextId });
        assert.deepEqual(inspectManagedSubagent(store.db, context, {
          taskName: delegated.carrier.taskName,
          agentId: "child-created-without-pretooluse",
        }), {
          managed: true,
          trusted: false,
          contextPackage: null,
        });
        const claim = store.transaction(() => claimDelegationSubagent(store.db, context, {
          taskName: delegated.carrier.taskName,
          agentId: "child-created-without-pretooluse",
          model: delegated.target.model,
        }));
        assert.deepEqual(claim, {
          matched: true,
          allowed: false,
          reason: "dispatch_ticket_unconsumed",
        });
        const attempt = store.db.prepare(`
          SELECT ticket_consumed, early_agent_id, ambiguous, finalized_at
          FROM delegation_attempts WHERE route_id = ?
        `).get(delegated.routeId);
        assert.equal(attempt.ticket_consumed, 0);
        assert.equal(typeof attempt.early_agent_id, "string");
        assert.equal(attempt.ambiguous, 1);
        assert.equal(attempt.finalized_at, null);
        const delayedPreToolUse = store.transaction(() => consumeDelegationTicket(store.db, context, {
          taskName: delegated.carrier.taskName,
          turnId: "late-root-turn",
          toolUseId: "late-tool-use",
          toolInput: {
            message: "gAAAA-encrypted-activation",
            task_name: delegated.carrier.taskName,
            model: delegated.target.model,
            reasoning_effort: delegated.target.effort,
            fork_turns: "none",
          },
        }));
        assert.equal(delayedPreToolUse.allowed, false);
        assert.match(delayedPreToolUse.reason, /reconciliation/i);
        assert.equal(store.status(context).delegationGate.routeId, delegated.routeId);
      } finally {
        store.close();
      }
    });
  } finally {
    await project.cleanup();
  }
});

function runHook(mode, input, home, env = {}) {
  return spawnSync(process.execPath, [hookPath, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      ADAPTIVE_ROUTER_HOME: home,
      ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      ...env,
    },
  });
}

function runRouteWorker(project, contextId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, "route-only", project.root, contextId, ""], {
      env: {
        ...process.env,
        ADAPTIVE_ROUTER_HOME: project.home,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
  });
}

function outcome(route, contextId, status = "passed") {
  return {
    routeId: route.routeId,
    contextId,
    status,
    gate: route.verificationGate,
    failureType: status === "failed" ? "tooling" : null,
    retries: 0,
    retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
    escalations: route.escalation.count,
    userCorrection: false,
  };
}

function completeCreatedChildRoute(route, { store, cwd, contextId }) {
  const context = store.context({ cwd, contextId });
  const agentId = `child-${route.routeId}`;
  const toolInput = {
    message: route.carrier.message,
    task_name: route.carrier.taskName,
    model: route.target.model,
    reasoning_effort: route.target.effort,
    fork_turns: "none",
  };
  store.transaction(() => consumeDelegationTicket(store.db, context, {
    taskName: route.carrier.taskName,
    turnId: `turn-${route.routeId}`,
    toolUseId: `tool-${route.routeId}`,
    toolInput,
  }));
  store.transaction(() => observeAgentResult(store.db, context, {
    turnId: `turn-${route.routeId}`,
    toolUseId: `tool-${route.routeId}`,
    toolInput,
    toolResponse: { agent_id: agentId, task_name: route.carrier.taskName },
  }));
  store.transaction(() => observeSubagentStop(
    store.db,
    context,
    route.carrier.taskName,
    agentId,
    128,
  ));
  return recordOutcome(outcome(route, contextId), { store, cwd });
}

test("one unresolved delegation owns the context gate across repeated calls and process restart", async () => {
  const project = await temporaryProject("adaptive delegation gate restart ");
  try {
    await withRouterEnvironment(project, async () => {
      let store = new RouterStore();
      const options = { store, cwd: project.root, catalog: CATALOG, diskProbe: ampleDisk };
      const delegated = await routeStage(routeInput({ contextId: "same-context" }), options);
      const busy = await routeStage(routeInput({ contextId: "same-context" }), options);
      assert.equal(delegated.action, "delegate");
      assert.match(delegated.carrier.taskName, /^router_[a-f0-9]{32}$/u);
      assert.match(delegated.carrier.message, /trusted SubagentStart hook/u);
      assert.equal(busy.action, "busy");
      assert.notEqual(busy.routeId, delegated.routeId);
      assert.equal(busy.blockingRouteId, delegated.routeId);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 1);
      assert.throws(
        () => recordOutcome(outcome(busy, "same-context"), { store, cwd: project.root }),
        /does not exist|does not belong|delegated routes/u,
      );
      assert.equal(store.status(store.context({ cwd: project.root, contextId: "same-context" })).delegationGate.routeId, delegated.routeId);
      store.close();

      store = new RouterStore();
      const afterRestart = await routeStage(routeInput({ contextId: "same-context" }), {
        ...options,
        store,
      });
      assert.equal(afterRestart.action, "busy");
      assert.equal(afterRestart.blockingRouteId, delegated.routeId);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("record_outcome rejects a route that never crossed the dispatch handshake", async () => {
  const project = await temporaryProject("adaptive outcome before dispatch ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "outcome-before-dispatch";
      const route = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(route.action, "delegate");
      assert.throws(
        () => recordOutcome(outcome(route, contextId, "failed"), { store, cwd: project.root }),
        /dispatch handshake/u,
      );
      const status = store.status(store.context({ cwd: project.root, contextId }));
      assert.equal(status.delegationGate.routeId, route.routeId);
      assert.equal(status.delegationGate.ticketConsumed, false);
      assert.equal(status.delegationGate.outcomeRecorded, false);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("an active gate cannot be hidden by a later unavailable capability claim", async () => {
  const project = await temporaryProject("adaptive gate capability precedence ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "gate-capability-precedence";
      const route = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      const masked = await routeStage(routeInput({
        contextId,
        hostCapabilities: {
          delegation: { available: false, invocation: "unavailable", targets: [] },
        },
      }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(masked.action, "busy");
      assert.equal(masked.blockingRouteId, route.routeId);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 1);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("a proven direct child prevents an unsupported capability downgrade", async () => {
  const project = await temporaryProject("adaptive proven direct capability ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "proven-direct-capability";
      const route = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      completeCreatedChildRoute(route, { store, cwd: project.root, contextId });
      await assert.rejects(
        routeStage(routeInput({
          contextId,
          hostCapabilities: {
            delegation: { available: false, invocation: "unavailable", targets: [] },
          },
        }), {
          store,
          cwd: project.root,
          catalog: CATALOG,
          diskProbe: ampleDisk,
        }),
        /previously observed direct delegation/u,
      );
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("an authoritative no-child tooling rejection permits a capability downgrade", async () => {
  const project = await temporaryProject("adaptive authoritative capability rejection ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "authoritative-capability-rejection";
      const proven = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      completeCreatedChildRoute(proven, { store, cwd: project.root, contextId });

      const rejected = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      completeNoChildRoute(rejected, {
        store,
        cwd: project.root,
        contextId,
        status: "failed",
        failureType: "tooling",
      });

      const downgraded = await routeStage(routeInput({
        contextId,
        previousRouteId: rejected.routeId,
        evidence: {
          ...routeInput().evidence,
          verificationFailed: true,
          failureType: "tooling",
        },
        hostCapabilities: {
          delegation: { available: false, invocation: "unavailable", targets: [] },
        },
      }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(downgraded.action, "continue");
      assert.deepEqual(downgraded.reasonCodes, ["HOST_DELEGATION_UNAVAILABLE"]);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("50 concurrent eligible route processes produce one delegate and 49 busy results", async () => {
  const project = await temporaryProject("adaptive delegation storm ");
  try {
    const routes = await Promise.all(
      Array.from({ length: 50 }, () => runRouteWorker(project, "storm-context")),
    );
    const delegated = routes.filter((route) => route.action === "delegate");
    const busy = routes.filter((route) => route.action === "busy");
    assert.equal(delegated.length, 1);
    assert.equal(busy.length, 49);
    assert.ok(busy.every((route) => route.blockingRouteId === delegated[0].routeId));
    const store = new RouterStore({ path: join(project.home, "router.sqlite3") });
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 1);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM delegation_attempts WHERE finalized_at IS NULL").get().count), 1);
    store.close();
  } finally {
    await project.cleanup();
  }
});

test("host-wide reservations cap unresolved Router children across contexts", async () => {
  const project = await temporaryProject("adaptive cross-context capacity ");
  try {
    await withRouterEnvironment(project, async () => {
      const floorOnly = await routeStage(routeInput({ contextId: "floor-only" }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: () => 4n * 1024n * 1024n * 1024n,
      });
      assert.equal(floorOnly.action, "continue");
      assert.deepEqual(floorOnly.reasonCodes, ["LOW_DISK_FALLBACK"]);

      const routes = [];
      for (let index = 0; index < 5; index += 1) {
        routes.push(await routeStage(routeInput({ contextId: `capacity-${index}` }), {
          cwd: project.root,
          catalog: CATALOG,
          diskProbe: ampleDisk,
        }));
      }
      assert.equal(routes.filter((route) => route.action === "delegate").length, 4);
      assert.equal(routes[4].action, "continue");
      assert.deepEqual(routes[4].reasonCodes, ["ROUTER_CHILD_STORAGE_LIMIT"]);
    });
  } finally {
    await project.cleanup();
  }
});

test("v3 migration quarantines legacy delegate routes without outcomes", async () => {
  const project = await temporaryProject("adaptive legacy migration ");
  const database = join(project.home, "router.sqlite3");
  const legacyRoutes = [];
  try {
    await withRouterEnvironment(project, async () => {
      for (let index = 0; index < 2; index += 1) {
        const route = await routeStage(routeInput({ contextId: `legacy-${index}` }), {
          cwd: project.root,
          catalog: CATALOG,
          diskProbe: ampleDisk,
        });
        assert.equal(route.action, "delegate");
        legacyRoutes.push(route);
      }
    });
    const legacy = new DatabaseSync(database);
    legacy.exec(`
      DROP TRIGGER require_router_delegation_attempt;
      DROP TABLE delegation_attempts;
      DROP TABLE delegation_usage;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new RouterStore({ path: database });
    assert.equal(Number(migrated.db.prepare("SELECT count(*) AS count FROM delegation_attempts").get().count), 0);
    const next = await routeStage(routeInput({ contextId: "legacy-0" }), {
      store: migrated,
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    });
    assert.equal(next.action, "busy");
    assert.equal(next.blockingRouteId, legacyRoutes[0].routeId);
    assert.equal(Number(migrated.db.prepare("SELECT count(*) AS count FROM routes").get().count), 2);
    assert.equal(
      migrated.status(migrated.context({ cwd: project.root, contextId: "legacy-0" }))
        .delegationGate.reason,
      "legacy_cutover_unresolved",
    );
    migrated.close();
  } finally {
    await project.cleanup();
  }
});

test("opening v5 storage quarantines a legacy outcome recorded before dispatch", async () => {
  const project = await temporaryProject("adaptive legacy predispatch outcome ");
  const database = join(project.home, "router.sqlite3");
  try {
    let delegated;
    await withRouterEnvironment(project, async () => {
      delegated = await routeStage(routeInput({ contextId: "legacy-predispatch" }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(delegated.action, "delegate");
    });

    const legacy = new DatabaseSync(database);
    const route = legacy.prepare("SELECT * FROM routes WHERE route_id = ?").get(delegated.routeId);
    legacy.prepare(`
      INSERT INTO outcomes(
        route_id, project_id, context_key, category, status, gate, failure_type,
        retries, retry_reasoning, retry_environment, retry_information, retry_tooling,
        escalations, user_correction, payload_hash, recorded_at
      ) VALUES(?, ?, ?, ?, 'failed', ?, 'tooling', 0, 0, 0, 0, 0, 0, 0, ?, ?)
    `).run(
      route.route_id,
      route.project_id,
      route.context_key,
      route.category,
      route.verification_gate,
      "legacy-predispatch-outcome",
      new Date().toISOString(),
    );
    legacy.prepare(`
      UPDATE delegation_attempts
      SET outcome_recorded = 1, outcome_status = 'failed'
      WHERE route_id = ?
    `).run(delegated.routeId);
    legacy.close();

    await withRouterEnvironment(project, async () => {
      const repaired = new RouterStore({ path: database });
      const attempt = repaired.db.prepare(`
        SELECT ticket_consumed, ticket_hash, context_package, outcome_recorded,
               outcome_status, ambiguous, finalized_at
        FROM delegation_attempts WHERE route_id = ?
      `).get(delegated.routeId);
      assert.equal(attempt.ticket_consumed, 0);
      assert.equal(attempt.ticket_hash, null);
      assert.equal(attempt.context_package, null);
      assert.equal(attempt.outcome_recorded, 1);
      assert.equal(attempt.outcome_status, "failed");
      assert.equal(attempt.ambiguous, 1);
      assert.ok(attempt.finalized_at);
      assert.equal(
        repaired.db.prepare("SELECT eligible_learning FROM route_score_snapshots WHERE route_id = ?")
          .get(delegated.routeId).eligible_learning,
        0,
      );

      const context = repaired.context({ cwd: project.root, contextId: "legacy-predispatch" });
      assert.deepEqual(repaired.status(context).delegationGate, { state: "available" });
      const next = await routeStage(routeInput({ contextId: "legacy-predispatch" }), {
        store: repaired,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(next.action, "delegate", JSON.stringify(next));
      repaired.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("guarded Stop reentry never archives an attempt whose dispatch ticket was consumed", async () => {
  const project = await temporaryProject("adaptive consumed stop reentry ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "consumed-stop-reentry";
      const delegated = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(delegated.action, "delegate");
      observeNoChildRoute(delegated, { cwd: project.root, contextId, store });

      const context = store.context({ cwd: project.root, contextId });
      const stopped = store.handleStop(context, { stopHookActive: true });
      assert.equal(stopped.action, "allow");
      assert.equal(stopped.gateRetained, true);
      const attempt = store.db.prepare(`
        SELECT ticket_consumed, post_observed, no_child, outcome_recorded, finalized_at
        FROM delegation_attempts WHERE route_id = ?
      `).get(delegated.routeId);
      assert.equal(attempt.ticket_consumed, 1);
      assert.equal(attempt.post_observed, 1);
      assert.equal(attempt.no_child, 1);
      assert.equal(attempt.outcome_recorded, 0);
      assert.equal(attempt.finalized_at, null);
      assert.equal(store.status(context).delegationGate.routeId, delegated.routeId);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("v5 database rejects an ungated delegate insert from an older runtime", async () => {
  const project = await temporaryProject("adaptive old writer ");
  try {
    await withRouterEnvironment(project, async () => {
      const route = await routeStage(routeInput({ contextId: "old-writer" }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(route.action, "delegate");
      const store = new RouterStore();
      assert.equal(store.db.prepare("PRAGMA foreign_key_list(routes)").all().length, 0);
      assert.ok(store.db.prepare("PRAGMA foreign_key_list(route_score_snapshots)").all()
        .some((foreignKey) => foreignKey.table === "routes" && foreignKey.from === "route_id"));
      assert.ok(store.db.prepare("PRAGMA foreign_key_list(delegation_attempts)").all()
        .some((foreignKey) => foreignKey.table === "routes" && foreignKey.from === "route_id"));
      assert.throws(() => store.db.prepare(`
        INSERT INTO routes(
          route_id, project_id, context_key, schema_version, action, category, model, effort,
          family, root_model, verification_gate, reason_codes_json, classifier_state,
          escalation_count, previous_route_id, created_at
        )
        SELECT 'old-runtime-ungated', project_id, context_key, schema_version, action, category,
          model, effort, family, root_model, verification_gate, reason_codes_json,
          classifier_state, escalation_count, previous_route_id, created_at
        FROM routes WHERE route_id = ?
      `).run(route.routeId), /atomic gate admission/u);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 1);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("low or untrusted free-disk state and oversized context stay root-only without tickets", async () => {
  const project = await temporaryProject("adaptive delegation safeguards ");
  try {
    await withRouterEnvironment(project, async () => {
      const low = await routeStage(routeInput({ contextId: "low-disk" }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: () => 1n,
      });
      assert.equal(low.action, "continue");
      assert.deepEqual(low.reasonCodes, ["LOW_DISK_FALLBACK"]);
      assert.equal(low.carrier, undefined);

      const unknown = await routeStage(routeInput({ contextId: "unknown-disk" }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: () => { throw new Error("unavailable"); },
      });
      assert.equal(unknown.action, "continue");
      assert.deepEqual(unknown.reasonCodes, ["DISK_STATE_UNAVAILABLE"]);

      const oversized = await routeStage(routeInput({
        contextId: "large-context",
        goal: "界".repeat(CONTEXT_PACKAGE_BYTE_LIMIT),
      }), { cwd: project.root, catalog: CATALOG, diskProbe: ampleDisk });
      assert.equal(oversized.action, "continue");
      assert.deepEqual(oversized.reasonCodes, ["CONTEXT_PACKAGE_TOO_LARGE"]);

      const budgetStore = new RouterStore();
      const budgetContext = budgetStore.context({ cwd: project.root, contextId: "child-budget" });
      budgetStore.db.prepare(`
        INSERT INTO delegation_usage(project_id, context_key, total_transcript_bytes, untrusted, updated_at)
        VALUES(?, ?, ?, 0, ?)
      `).run(budgetContext.projectId, budgetContext.contextKey, 1024 * 1024 * 1024, new Date().toISOString());
      const exhausted = await routeStage(routeInput({ contextId: "child-budget" }), {
        store: budgetStore,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(exhausted.action, "continue");
      assert.deepEqual(exhausted.reasonCodes, ["ROUTER_CHILD_STORAGE_LIMIT"]);
      budgetStore.close();

      const store = new RouterStore();
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM delegation_attempts").get().count), 0);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("untrusted, mismatched, or unavailable lifecycle hooks stay root-only without tickets", async () => {
  const project = await temporaryProject("adaptive lifecycle readiness ");
  try {
    await withRouterEnvironment(project, async () => {
      for (const reasonCode of [
        "HOOK_TRUST_REQUIRED",
        "HOST_HOOK_SET_MISMATCH",
        "HOST_HOOK_STATUS_UNAVAILABLE",
      ]) {
        const route = await routeStage(routeInput({ contextId: reasonCode }), {
          cwd: project.root,
          catalog: CATALOG,
          diskProbe: ampleDisk,
          lifecycleHookProbe: async () => ({ ready: false, reasonCode }),
        });
        assert.equal(route.action, "continue");
        assert.deepEqual(route.reasonCodes, [reasonCode]);
        assert.equal(route.carrier, undefined);
      }
      const thrown = await routeStage(routeInput({ contextId: "hook-probe-threw" }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
        lifecycleHookProbe: async () => { throw new Error("probe failed"); },
      });
      assert.equal(thrown.action, "continue");
      assert.deepEqual(thrown.reasonCodes, ["HOST_HOOK_STATUS_UNAVAILABLE"]);

      const store = new RouterStore();
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM delegation_attempts").get().count), 0);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes WHERE action = 'delegate'").get().count), 0);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("an occupied delegation gate reports busy without running the Hook readiness probe", async () => {
  const project = await temporaryProject("adaptive busy before readiness ");
  try {
    await withRouterEnvironment(project, async () => {
      const contextId = "busy-before-readiness";
      const delegated = await routeStage(routeInput({ contextId }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      let readinessCalls = 0;
      const busy = await routeStage(routeInput({ contextId }), {
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
        lifecycleHookProbe: async () => {
          readinessCalls += 1;
          return { ready: false, reasonCode: "HOOK_TRUST_REQUIRED" };
        },
      });
      assert.equal(busy.action, "busy");
      assert.equal(busy.blockingRouteId, delegated.routeId);
      assert.equal(readinessCalls, 0);
    });
  } finally {
    await project.cleanup();
  }
});

test("Agent hooks validate and consume Router tickets without rewriting encrypted input", async () => {
  const project = await temporaryProject("adaptive delegation hooks ");
  try {
    const contextId = "hook-context";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const unmarked = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-manual",
      tool_use_id: "tool-manual",
      tool_name: "Agent",
      tool_input: { message: "manual agent", task_name: "manual_agent", fork_turns: "all" },
    }, project.home);
    assert.equal(unmarked.status, 0, unmarked.stderr);
    assert.equal(unmarked.stdout, "");
    const discussedMarker = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-discussion",
      tool_use_id: "tool-discussion",
      tool_name: "Agent",
      tool_input: { message: "Explain the literal [[adaptive-model-router:ticket: prefix.", fork_turns: "all" },
    }, project.home);
    assert.equal(discussedMarker.status, 0, discussedMarker.stderr);
    assert.equal(discussedMarker.stdout, "");

    const legacy = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-legacy",
      tool_use_id: "tool-legacy",
      tool_name: "Agent",
      tool_input: { message: "[[adaptive-model-router:ticket:legacy]]", task_name: "old_router", fork_turns: "none" },
    }, project.home);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(
      JSON.parse(legacy.stdout).hookSpecificOutput.permissionDecisionReason,
      /Legacy Router message carriers are unsupported/u,
    );

    const toolInput = {
      message: "gAAAA-host-encrypted-router-activation",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const wrongTarget = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-wrong-target",
      tool_use_id: "tool-wrong-target",
      tool_name: "Agent",
      tool_input: { ...toolInput, model: "gpt-5.6-luna", reasoning_effort: "low" },
    }, project.home);
    assert.equal(wrongTarget.status, 0);
    assert.deepEqual(JSON.parse(wrongTarget.stdout).hookSpecificOutput, {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Router-marked Agent model or reasoning effort does not match the admitted route.",
    });

    const unsafeFork = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-unsafe-fork",
      tool_use_id: "tool-unsafe-fork",
      tool_name: "spawn_agent",
      tool_input: { ...toolInput, fork_turns: "all" },
    }, project.home);
    assert.equal(unsafeFork.status, 0, unsafeFork.stderr);
    assert.deepEqual(JSON.parse(unsafeFork.stdout).hookSpecificOutput, {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Router-marked Agent call must use fork_turns=none before trusted dispatch.",
    });

    const allowed = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-router",
      tool_use_id: "tool-router",
      tool_name: "Agent",
      tool_input: toolInput,
    }, project.home);
    assert.equal(allowed.status, 0, allowed.stderr);
    // Native Codex rejects permissionDecision=allow. An admitted ticket keeps
    // ordinary host permission checks and continues with an empty JSON object.
    assert.deepEqual(JSON.parse(allowed.stdout), {});

    const replay = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-router",
      tool_use_id: "tool-router-replay",
      tool_name: "Agent",
      tool_input: toolInput,
    }, project.home);
    assert.equal(replay.status, 0);
    assert.equal(JSON.parse(replay.stdout).hookSpecificOutput.permissionDecision, "deny");

    const routerLikeManual = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-router",
      tool_use_id: "tool-router-like-manual",
      tool_name: "Agent",
      tool_input: { ...toolInput, task_name: "router_bad" },
    }, project.home);
    assert.equal(routerLikeManual.status, 0);
    assert.equal(routerLikeManual.stdout, "");

    const forged = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-router",
      tool_use_id: "tool-forged",
      tool_name: "Agent",
      tool_input: { ...toolInput, task_name: `router_${"0".repeat(32)}` },
    }, project.home);
    assert.equal(forged.status, 0);
    assert.equal(JSON.parse(forged.stdout).hookSpecificOutput.permissionDecision, "deny");

    const unusableHome = join(project.root, "not-a-directory");
    await writeFile(unusableHome, "block database directory creation", "utf8");
    const stateFailure = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-state-failure",
      tool_use_id: "tool-state-failure",
      tool_name: "Agent",
      tool_input: toolInput,
    }, unusableHome);
    assert.equal(stateFailure.status, 0);
    assert.deepEqual(JSON.parse(stateFailure.stdout).hookSpecificOutput, {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Router-marked Agent call could not be validated against trusted durable state.",
    });
  } finally {
    await project.cleanup();
  }
});

test("unrelated manual Agent lifecycle hooks do not create Router state", async () => {
  const project = await temporaryProject("adaptive manual lifecycle ");
  try {
    const transcript = join(project.root, "manual.jsonl");
    await writeChildTranscript(transcript, {
      parentId: "manual-context",
      childId: "manual-agent",
      taskName: "manual_child",
      cwd: project.root,
      body: "manual child transcript\n",
    });
    const started = runHook("subagent-start", {
      cwd: project.root,
      session_id: "manual-context",
      agent_id: "manual-agent",
      model: "gpt-5.6-terra",
      transcript_path: transcript,
    }, project.home);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, "");
    const prompt = runHook("prompt", {
      cwd: project.root,
      session_id: "manual-context",
      agent_id: "manual-agent",
      model: "gpt-5.6-terra",
      transcript_path: transcript,
      prompt: "Continue the manual child.",
    }, project.home);
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout, "");
    const post = runHook("post-tool-use", {
      cwd: project.root,
      session_id: "manual-context",
      turn_id: "manual-turn",
      tool_use_id: "manual-tool",
      tool_name: "Agent",
      tool_input: { message: "manual child", fork_turns: "all" },
      tool_response: { agent_id: "manual-agent" },
    }, project.home);
    assert.equal(post.status, 0, post.stderr);
    assert.equal(post.stdout, "");
    const stopped = runHook("subagent-stop", {
      cwd: project.root,
      session_id: "manual-context",
      agent_id: "manual-agent",
      agent_transcript_path: transcript,
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {});
    assert.equal(existsSync(join(project.home, "router.sqlite3")), false);
  } finally {
    await project.cleanup();
  }
});

test("an unmarked manual child cannot claim or mutate an active Router attempt", async () => {
  const project = await temporaryProject("adaptive manual beside Router ");
  try {
    const contextId = "shared-parent";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const original = {
      message: "gAAAA-encrypted-router-activation",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const pre = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "router-turn",
      tool_use_id: "router-tool",
      tool_name: "spawn_agent",
      tool_input: original,
    }, project.home);
    assert.equal(pre.status, 0, pre.stderr);

    const manualTranscript = join(project.root, "manual-beside-router.jsonl");
    await writeChildTranscript(manualTranscript, {
      parentId: contextId,
      childId: "manual-agent",
      taskName: "manual_child",
      cwd: project.root,
      body: "manual work\n",
    });
    for (const [mode, input] of [
      ["subagent-start", {
        cwd: project.root,
        session_id: contextId,
        agent_id: "manual-agent",
        model: delegated.target.model,
        transcript_path: manualTranscript,
      }],
      ["prompt", {
        cwd: project.root,
        session_id: contextId,
        agent_id: "manual-agent",
        model: delegated.target.model,
        transcript_path: manualTranscript,
        prompt: "Manual work only.",
      }],
    ]) {
      const result = runHook(mode, input, project.home);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
    const manualStopped = runHook("subagent-stop", {
      cwd: project.root,
      session_id: contextId,
      agent_id: "manual-agent",
      agent_transcript_path: manualTranscript,
    }, project.home);
    assert.equal(manualStopped.status, 0, manualStopped.stderr);
    assert.deepEqual(JSON.parse(manualStopped.stdout), {});

    await withRouterEnvironment(project, () => {
      const store = new RouterStore();
      const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?")
        .get(delegated.routeId);
      assert.equal(attempt.ticket_consumed, 1);
      assert.equal(attempt.early_agent_id, null);
      assert.equal(attempt.agent_id, null);
      assert.equal(attempt.stop_observed, 0);
      assert.equal(attempt.ambiguous, 0);
      store.close();
    });

    const routerTranscript = join(project.root, "router-child.jsonl");
    await writeChildTranscript(routerTranscript, {
      parentId: contextId,
      childId: "router-agent",
      taskName: delegated.carrier.taskName,
      cwd: project.root,
      body: "router work\n",
    });
    const routerStarted = runHook("subagent-start", {
      cwd: project.root,
      session_id: contextId,
      agent_id: "router-agent",
      model: delegated.target.model,
      transcript_path: routerTranscript,
    }, project.home);
    assert.equal(routerStarted.status, 0, routerStarted.stderr);
    assert.match(routerStarted.stdout, /bounded context package/u);
  } finally {
    await project.cleanup();
  }
});

test("a fast SubagentStop before PostToolUse is correlated by agent id and transcript size", async () => {
  const project = await temporaryProject("adaptive delegation ordering ");
  try {
    const contextId = "ordering-context";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const original = {
      message: "gAAAA-encrypted-fast-activation",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const pre = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-fast",
      tool_use_id: "tool-fast",
      tool_name: "Agent",
      tool_input: original,
    }, project.home);
    const dispatched = original;
    const transcript = join(project.root, "fast-child.jsonl");
    const transcriptBytes = await writeChildTranscript(transcript, {
      parentId: contextId,
      childId: "agent-fast",
      taskName: delegated.carrier.taskName,
      cwd: project.root,
      body: "fast child transcript\n",
    });
    const started = runHook("subagent-start", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-fast",
      agent_id: "agent-fast",
      model: delegated.target.model,
      transcript_path: transcript,
    }, project.home);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /bounded context package/u);
    assert.match(started.stdout, /Implement the specified parser/u);
    const stopped = runHook("subagent-stop", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-fast",
      agent_id: "agent-fast",
      agent_transcript_path: transcript,
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    const post = runHook("post-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-fast",
      tool_use_id: "tool-fast",
      tool_name: "Agent",
      tool_input: dispatched,
      tool_response: JSON.stringify({
        task_name: `/root/${delegated.carrier.taskName}`,
        nickname: "Bounded",
      }),
    }, project.home);
    assert.equal(post.status, 0, post.stderr);
    await withRouterEnvironment(project, () => recordOutcome(outcome(delegated, contextId), { cwd: project.root }));
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId });
      assert.deepEqual(store.status(context).delegationGate, { state: "available" });
      assert.ok(Number(store.db.prepare(`
        SELECT total_transcript_bytes AS bytes FROM delegation_usage
        WHERE project_id = ? AND context_key = ?
      `).get(context.projectId, context.contextKey).bytes) >= transcriptBytes);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("a task-name-only PostToolUse before SubagentStart waits for the trusted child claim", async () => {
  const project = await temporaryProject("adaptive delegation post before start ");
  try {
    const contextId = "post-before-start-context";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const original = {
      message: "gAAAA-encrypted-post-before-start",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const pre = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-post-first",
      tool_use_id: "tool-post-first",
      tool_name: "spawn_agent",
      tool_input: original,
    }, project.home);
    assert.equal(pre.status, 0, pre.stderr);

    const post = runHook("post-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-post-first",
      tool_use_id: "tool-post-first",
      tool_name: "spawn_agent",
      tool_input: original,
      tool_response: JSON.stringify({
        task_name: `/root/${delegated.carrier.taskName}`,
      }),
    }, project.home);
    assert.equal(post.status, 0, post.stderr);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?")
        .get(delegated.routeId);
      assert.equal(attempt.post_observed, 1);
      assert.equal(attempt.agent_id, null);
      assert.equal(attempt.early_agent_id, null);
      assert.equal(attempt.ambiguous, 0);
      const blocked = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(blocked.action, "busy");
      assert.equal(blocked.blockingRouteId, delegated.routeId);
      store.close();
    });

    const transcript = join(project.root, "post-before-start-child.jsonl");
    await writeChildTranscript(transcript, {
      parentId: contextId,
      childId: "agent-post-first",
      taskName: delegated.carrier.taskName,
      cwd: project.root,
      body: "post before start child transcript\n",
    });
    const started = runHook("subagent-start", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-post-first",
      agent_id: "agent-post-first",
      model: delegated.target.model,
      transcript_path: transcript,
    }, project.home);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /bounded context package/u);

    await withRouterEnvironment(project, () => {
      const store = new RouterStore();
      const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?")
        .get(delegated.routeId);
      assert.equal(typeof attempt.agent_id, "string");
      assert.equal(attempt.agent_id, attempt.early_agent_id);
      assert.equal(attempt.ambiguous, 0);
      store.close();
    });

    const stopped = runHook("subagent-stop", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-post-first",
      agent_id: "agent-post-first",
      agent_transcript_path: transcript,
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {});
    await withRouterEnvironment(project, () => recordOutcome(outcome(delegated, contextId), {
      cwd: project.root,
    }));

    await withRouterEnvironment(project, () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId });
      assert.deepEqual(store.status(context).delegationGate, { state: "available" });
      const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?")
        .get(delegated.routeId);
      assert.equal(attempt.post_observed, 1);
      assert.equal(attempt.stop_observed, 1);
      assert.equal(attempt.outcome_recorded, 1);
      assert.equal(attempt.ambiguous, 0);
      assert.equal(typeof attempt.finalized_at, "string");
      assert.ok(attempt.transcript_bytes > 0);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("an ambiguous multi-child lifecycle can never auto-release the delegation gate", async () => {
  const project = await temporaryProject("adaptive delegation multi-child ambiguity ");
  try {
    const contextId = "multi-child-ambiguity";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const original = {
      message: "gAAAA-encrypted-multi-child-activation",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const pre = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-multi-child",
      tool_use_id: "tool-multi-child",
      tool_name: "spawn_agent",
      tool_input: original,
    }, project.home);
    const dispatched = original;
    const firstTranscript = join(project.root, "first-child.jsonl");
    const secondTranscript = join(project.root, "second-child.jsonl");
    await writeChildTranscript(firstTranscript, {
      parentId: contextId,
      childId: "agent-first",
      taskName: delegated.carrier.taskName,
      cwd: project.root,
      body: "first child\n",
    });
    await writeChildTranscript(secondTranscript, {
      parentId: contextId,
      childId: "agent-second",
      taskName: delegated.carrier.taskName,
      cwd: project.root,
      body: "second child\n",
    });
    for (const [agentId, transcript] of [
      ["agent-first", firstTranscript],
      ["agent-second", secondTranscript],
    ]) {
      const started = runHook("subagent-start", {
        cwd: project.root,
        session_id: contextId,
        agent_id: agentId,
        model: delegated.target.model,
        transcript_path: transcript,
      }, project.home);
      assert.equal(started.status, 0, started.stderr);
      const stopped = runHook("subagent-stop", {
        cwd: project.root,
        session_id: contextId,
        agent_id: agentId,
        agent_transcript_path: transcript,
      }, project.home);
      assert.equal(stopped.status, 0, stopped.stderr);
    }
    await withRouterEnvironment(project, () => recordOutcome(outcome(delegated, contextId), {
      cwd: project.root,
    }));
    const post = runHook("post-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-multi-child",
      tool_use_id: "tool-multi-child",
      tool_name: "spawn_agent",
      tool_input: dispatched,
      tool_response: JSON.stringify({ task_name: `/root/${delegated.carrier.taskName}` }),
    }, project.home);
    assert.equal(post.status, 0, post.stderr);

    await withRouterEnvironment(project, () => {
      const store = new RouterStore();
      const gate = store.status(store.context({ cwd: project.root, contextId })).delegationGate;
      assert.equal(gate.state, "occupied");
      assert.equal(gate.ambiguous, true);
      assert.equal(gate.outcomeRecorded, true);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("generic Agent errors and unstatable transcripts retain the gate fail closed", async () => {
  const project = await temporaryProject("adaptive delegation ambiguous ");
  try {
    const contextId = "ambiguous-context";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const original = {
      message: "gAAAA-encrypted-ambiguous-activation",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const pre = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-ambiguous",
      tool_use_id: "tool-ambiguous",
      tool_name: "Agent",
      tool_input: original,
    }, project.home);
    const dispatched = original;
    const post = runHook("post-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-ambiguous",
      tool_use_id: "tool-ambiguous",
      tool_name: "Agent",
      tool_input: dispatched,
      tool_response: { isError: true, status: "failed", error: "unknown launch state", agent_id: "agent-ambiguous" },
    }, project.home);
    assert.equal(post.status, 0, post.stderr);
    const stopped = runHook("subagent-stop", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-ambiguous",
      agent_id: "agent-ambiguous",
      agent_transcript_path: join(project.root, "missing-transcript.jsonl"),
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    await withRouterEnvironment(project, () => recordOutcome(outcome(delegated, contextId, "failed"), { cwd: project.root }));
    const blocked = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    assert.equal(blocked.action, "busy");
    assert.equal(blocked.blockingRouteId, delegated.routeId);
  } finally {
    await project.cleanup();
  }
});

test("PostToolUse and SubagentStop correlation release only after the route outcome", async () => {
  const project = await temporaryProject("adaptive delegation lifecycle ");
  try {
    const contextId = "lifecycle-context";
    const delegated = await withRouterEnvironment(project, () => routeStage(routeInput({ contextId }), {
      cwd: project.root,
      catalog: CATALOG,
      diskProbe: ampleDisk,
    }));
    const original = {
      message: "gAAAA-encrypted-lifecycle-activation",
      task_name: delegated.carrier.taskName,
      model: delegated.target.model,
      reasoning_effort: delegated.target.effort,
      fork_turns: "none",
    };
    const pre = runHook("pre-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-life",
      tool_use_id: "tool-life",
      tool_name: "Agent",
      tool_input: original,
    }, project.home);
    assert.equal(pre.status, 0, pre.stderr);
    const dispatched = original;

    const transcript = join(project.root, "child-transcript.jsonl");
    await writeChildTranscript(transcript, {
      parentId: contextId,
      childId: "agent-life",
      taskName: delegated.carrier.taskName,
      cwd: project.root,
      body: "bounded transcript\n",
    });
    const started = runHook("subagent-start", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-turn",
      agent_id: "agent-life",
      model: delegated.target.model,
      transcript_path: transcript,
    }, project.home);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /bounded context package/u);
    const post = runHook("post-tool-use", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "turn-life",
      tool_use_id: "tool-life",
      tool_name: "Agent",
      tool_input: dispatched,
      tool_response: JSON.stringify({
        task_name: `/root/${delegated.carrier.taskName}`,
        status: "accepted",
      }),
    }, project.home);
    assert.equal(post.status, 0, post.stderr);

    await withRouterEnvironment(project, () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId });
      assert.equal(store.status(context).delegationGate.childCorrelated, true);
      store.close();
    });

    const stopped = runHook("subagent-stop", {
      cwd: project.root,
      session_id: contextId,
      turn_id: "child-turn",
      agent_id: "agent-life",
      agent_type: "worker",
      agent_transcript_path: transcript,
      stop_hook_active: false,
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {});

    await withRouterEnvironment(project, () => recordOutcome(outcome(delegated, contextId), {
      cwd: project.root,
    }));
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId });
      assert.deepEqual(store.status(context).delegationGate, { state: "available" });
      const next = await routeStage(routeInput({ contextId }), {
        store,
        cwd: project.root,
        catalog: CATALOG,
        diskProbe: ampleDisk,
      });
      assert.equal(next.action, "delegate");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
