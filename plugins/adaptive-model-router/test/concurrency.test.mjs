import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import {
  consumeDelegationTicket,
  observeAgentResult,
} from "../scripts/lib/delegation-gate.mjs";
import { listPolicyProposals } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { CATALOG, routeInput, temporaryProject } from "./fixtures.mjs";

const worker = join(dirname(fileURLToPath(import.meta.url)), "concurrency-worker.mjs");

function runWorker(project, operation, contextId, value = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, operation, project.root, contextId, String(value)], {
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
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`worker ${operation} exited ${code}: ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`worker ${operation} returned invalid JSON: ${error.message}; ${stdout}; ${stderr}`));
        }
      }
    });
  });
}

test("50 processes concurrently migrate an empty SQLite database", async () => {
  const project = await temporaryProject("adaptive concurrency migration ");
  try {
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => runWorker(project, "migrate", `migration-${index}`)));
    assert.equal(results.length, 50);
    assert.ok(results.every((result) => result.version === 6 && result.health === "ok"));
    const store = new RouterStore({ path: join(project.home, "router.sqlite3") });
    assert.equal(Number(store.db.prepare("PRAGMA user_version").get().user_version), 6);
    store.close();
  } finally {
    await project.cleanup();
  }
});

test("50 concurrent Stop processes retain one pending gate without fabricating outcomes", async () => {
  const project = await temporaryProject("adaptive concurrency stop ");
  const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
  process.env.ADAPTIVE_ROUTER_HOME = project.home;
  try {
    const setup = new RouterStore();
    const route = await routeStage(routeInput({ contextId: "shared-stop" }), {
      catalog: CATALOG,
      cwd: project.root,
      store: setup,
    });
    assert.equal(route.action, "delegate");
    setup.close();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => runWorker(project, "stop", "shared-stop")),
    );
    assert.ok(results.every((result) => result.action === "block"));
    assert.equal(results.reduce((sum, result) => sum + result.recordedUnknown, 0), 0);
    assert.ok(results.every((result) => result.gateRetained === true));

    const verified = new RouterStore();
    assert.equal(Number(verified.db.prepare("SELECT count(*) AS count FROM outcomes").get().count), 0);
    const context = verified.context({ cwd: project.root, contextId: "shared-stop" });
    assert.equal(verified.status(context).outcomeObservability.stopHookUnknown, 0);
    assert.equal(verified.status(context).delegationGate.routeId, route.routeId);
    verified.close();
  } finally {
    if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
    else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
    await project.cleanup();
  }
});

test("concurrent Stop and verified outcome writers leave one consistent terminal outcome", async () => {
  const project = await temporaryProject("adaptive concurrency stop outcome race ");
  const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
  process.env.ADAPTIVE_ROUTER_HOME = project.home;
  try {
    const setup = new RouterStore();
    const route = await routeStage(routeInput({ contextId: "stop-outcome-race" }), {
      catalog: CATALOG,
      cwd: project.root,
      store: setup,
    });
    assert.equal(route.action, "delegate");
    const setupContext = setup.context({ cwd: project.root, contextId: "stop-outcome-race" });
    const toolInput = {
      message: route.carrier.message,
      task_name: route.carrier.taskName,
      model: route.target.model,
      reasoning_effort: route.target.effort,
      fork_turns: "none",
    };
    setup.transaction(() => consumeDelegationTicket(setup.db, setupContext, {
      taskName: route.carrier.taskName,
      turnId: "stop-outcome-race-turn",
      toolUseId: "stop-outcome-race-tool",
      toolInput,
    }));
    setup.transaction(() => observeAgentResult(setup.db, setupContext, {
      turnId: "stop-outcome-race-turn",
      toolUseId: "stop-outcome-race-tool",
      toolInput,
      toolResponse: { no_agent_created: true },
    }));
    setup.close();

    const recordPayload = JSON.stringify({
      routeId: route.routeId,
      gate: route.verificationGate,
      escalations: route.escalation.count,
    });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => runWorker(project, "stop", "stop-outcome-race")),
      ...Array.from({ length: 10 }, () => (
        runWorker(project, "record-existing", "stop-outcome-race", recordPayload)
      )),
    ]);
    assert.equal(results.filter((result) => result.action === "allow").length, 10);
    assert.equal(results.filter((result) => result.action === "record").length, 10);
    assert.ok([0, 10].includes(results.filter((result) => result.conflict === true).length));

    const verified = new RouterStore();
    const rows = verified.db.prepare("SELECT route_id, status FROM outcomes").all()
      .map((row) => ({ ...row }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route_id, route.routeId);
    assert.equal(rows[0].status, "passed");
    const context = verified.context({ cwd: project.root, contextId: "stop-outcome-race" });
    const historyOutcome = verified.routeHistory(context).routes[0].outcome;
    const stopObservationCount = Number(verified.db.prepare(`
      SELECT count(*) AS count FROM stop_observations WHERE resolved_at IS NOT NULL
    `).get().count);
    assert.equal(historyOutcome.source, "record_outcome");
    assert.equal(stopObservationCount, 0);
    verified.close();
  } finally {
    if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
    else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
    await project.cleanup();
  }
});

test("concurrent routes claim once exactly once and new-policy outcomes remain outside legacy learning", async () => {
  const project = await temporaryProject("adaptive concurrency data ");
  const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
  process.env.ADAPTIVE_ROUTER_HOME = project.home;
  try {
    const setup = new RouterStore();
    const context = setup.context({ cwd: project.root, contextId: "shared" });
    setup.setOverride(context, { scope: "session", model: "gpt-6-astra", effort: "medium" });
    setup.setOverride(context, { scope: "once", model: "gpt-6-astra", effort: "high" });
    setup.close();

    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => runWorker(project, "route-outcome", "shared", index)));
    assert.equal(results.filter((result) => result.route.action === "delegate" && result.route.target.model === "gpt-6-astra").length, 1);
    assert.equal(results.filter((result) => result.route.action === "busy").length, 49);

    const store = new RouterStore();
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 1);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count), 1);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM overrides WHERE scope = 'once'").get().count), 0);
    assert.equal(listPolicyProposals({ contextId: "shared" }, { store, cwd: project.root }).length, 0);
    const firstResult = results.find((result) => result.route.action === "delegate");
    const firstRoute = firstResult.route;
    const sharedContext = store.context({ cwd: project.root, contextId: "shared" });
    const firstToolInput = {
      message: firstRoute.carrier.message,
      task_name: firstRoute.carrier.taskName,
      model: firstRoute.target.model,
      reasoning_effort: firstRoute.target.effort,
      fork_turns: "none",
    };
    store.transaction(() => observeAgentResult(store.db, sharedContext, {
      turnId: firstResult.dispatch.turnId,
      toolUseId: firstResult.dispatch.toolUseId,
      toolInput: firstToolInput,
      toolResponse: { no_agent_created: true },
    }));
    assert.equal(store.status(sharedContext).delegationGate.state, "available");
    store.clearOverrides(store.context({ cwd: project.root, contextId: "shared" }), "session");
    store.close();

    const learningResults = [];
    for (let offset = 0; offset < 12; offset += 4) {
      learningResults.push(...await Promise.all(Array.from({ length: 4 }, (_, index) => (
        runWorker(project, "route-outcome-complete", `learning-${offset + index}`, offset + index)
      ))));
    }
    assert.equal(
      learningResults.filter((result) => result.route.action === "delegate" && result.outcome?.recorded).length,
      12,
      JSON.stringify(learningResults.map((result) => ({
        action: result.route.action,
        reasons: result.route.reasonCodes,
        outcome: result.outcome,
      }))),
    );
    const proposalStore = new RouterStore();
    const proposals = listPolicyProposals({ contextId: "learning-0" }, { store: proposalStore, cwd: project.root });
    assert.equal(proposals.length, 0);
    assert.equal(proposalStore.db.prepare("SELECT count(*) AS n FROM route_score_snapshots WHERE eligible_learning=1").get().n, 0);
    proposalStore.close();
  } finally {
    if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
    else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
    await project.cleanup();
  }
});
