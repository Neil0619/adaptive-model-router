import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(pluginRoot, "scripts", "codex-route.mjs");

test("history shows timestamped model transitions, outcomes, filters, and the root-model boundary", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "timeline";
      const context = store.context({ cwd: project.root, contextId });
      store.observeHostModel(context, "gpt-5.6-sol", { detectChanges: false });
      const first = await routeStage(routeInput({
        contextId,
        override: { model: "gpt-5.6-terra", effort: "medium" },
      }), { catalog: CATALOG, cwd: project.root, store });
      recordOutcome({
        routeId: first.routeId,
        contextId,
        status: "passed",
        gate: first.verificationGate,
        failureType: null,
        retries: 0,
        escalations: 0,
        userCorrection: false,
      }, { store, cwd: project.root });
      const same = await routeStage(routeInput({
        contextId,
        override: { model: "gpt-5.6-terra", effort: "medium" },
      }), { catalog: CATALOG, cwd: project.root, store });
      const changed = await routeStage(routeInput({
        contextId,
        override: { model: "gpt-5.6-sol", effort: "high" },
      }), { catalog: CATALOG, cwd: project.root, store });
      recordOutcome({
        routeId: changed.routeId,
        contextId,
        status: "failed",
        gate: changed.verificationGate,
        failureType: "reasoning",
        retries: 1,
        escalations: 0,
        userCorrection: true,
      }, { store, cwd: project.root });
      const continued = await routeStage(routeInput({
        contextId,
        evidence: { workProduct: true, hostCanDelegate: false },
      }), { catalog: CATALOG, cwd: project.root, store });
      await routeStage(routeInput({
        contextId: "other-context",
        override: { model: "gpt-5.6-luna", effort: "low" },
      }), { catalog: CATALOG, cwd: project.root, store });

      const history = await callRouterTool("get_route_history", {
        contextId,
        limit: 10,
        action: "all",
      }, { store, cwd: project.root });
      assert.deepEqual(history.rootTask, {
        modelVisibility: "hook_observed",
        model: "gpt-5.6-sol",
        reasoningEffortVisibility: "host_only",
        changedByRouter: false,
      });
      assert.equal(history.scope, "current_project_context");
      assert.deepEqual(history.routes.map((route) => route.routeId), [
        continued.routeId,
        changed.routeId,
        same.routeId,
        first.routeId,
      ]);
      assert.equal(history.routes[0].transition.state, "not_delegated");
      assert.equal(history.routes[1].transition.state, "target_changed");
      assert.deepEqual(history.routes[1].transition.from, { model: "gpt-5.6-terra", effort: "medium" });
      assert.deepEqual(history.routes[1].transition.to, { model: "gpt-5.6-sol", effort: "high" });
      assert.equal(history.routes[1].outcome.status, "failed");
      assert.equal(history.routes[1].outcome.userCorrection, true);
      assert.equal(history.routes[2].transition.state, "target_unchanged");
      assert.equal(history.routes[2].outcome, null);
      assert.equal(history.routes[3].transition.state, "initial_delegate");
      assert.equal(history.routes[3].outcome.status, "passed");
      for (const route of history.routes) assert.equal(Number.isNaN(Date.parse(route.createdAt)), false);
      for (const route of history.routes) assert.equal(route.rootTask.model, "gpt-5.6-sol");

      const delegates = await callRouterTool("get_route_history", {
        contextId,
        limit: 2,
        action: "delegate",
      }, { store, cwd: project.root });
      assert.deepEqual(delegates.routes.map((route) => route.routeId), [changed.routeId, same.routeId]);

      const status = await callRouterTool("get_route_status", { contextId }, { store, cwd: project.root });
      assert.equal(status.latestRoute.routeId, continued.routeId);
      assert.equal(status.latestRoute.createdAt, history.routes[0].createdAt);
      assert.equal(typeof status.latestRoute.classifier, "string");
      assert.equal(typeof status.latestRoute.escalations, "number");
      assert.deepEqual(status.rootTask, history.rootTask);
      assert.deepEqual(status.currentStage, {
        state: "root",
        target: null,
        since: history.routes[0].createdAt,
      });
      store.close();

      const cli = spawnSync(process.execPath, [
        cliPath,
        "history",
        "--context",
        contextId,
        "--limit",
        "2",
        "--action",
        "delegate",
      ], {
        cwd: project.root,
        encoding: "utf8",
        env: { ...process.env },
      });
      assert.equal(cli.status, 0, cli.stderr);
      const cliHistory = JSON.parse(cli.stdout);
      assert.equal(cliHistory.routes.length, 2);
      assert.equal(cliHistory.routes[0].routeId, changed.routeId);
      assert.equal(cliHistory.rootTask.changedByRouter, false);
    });
  } finally {
    await project.cleanup();
  }
});

test("history validates limit and action without exposing another context", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      await routeStage(routeInput({ contextId: "visible" }), { catalog: CATALOG, cwd: project.root, store });
      await routeStage(routeInput({ contextId: "hidden" }), { catalog: CATALOG, cwd: project.root, store });
      const visible = store.routeHistory(store.context({ cwd: project.root, contextId: "visible" }));
      assert.equal(visible.routes.length, 1);
      assert.throws(
        () => store.routeHistory(store.context({ cwd: project.root, contextId: "visible" }), { limit: 0 }),
        /1 to 100/,
      );
      assert.throws(
        () => store.routeHistory(store.context({ cwd: project.root, contextId: "visible" }), { action: "invalid" }),
        /history action/,
      );
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("status currentStage distinguishes pending delegation, completed work, and ask_user", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "stage-state";
      const delegated = await routeStage(routeInput({ contextId }), { catalog: CATALOG, cwd: project.root, store });
      let status = store.status(store.context({ cwd: project.root, contextId }));
      assert.equal(status.currentStage.state, "delegated_pending_outcome");
      assert.deepEqual(status.currentStage.target, delegated.target);

      recordOutcome({
        routeId: delegated.routeId,
        contextId,
        status: "passed",
        gate: delegated.verificationGate,
        failureType: null,
        retries: 0,
        escalations: 0,
        userCorrection: false,
      }, { store, cwd: project.root });
      status = store.status(store.context({ cwd: project.root, contextId }));
      assert.equal(status.currentStage.state, "root");
      assert.equal(status.currentStage.target, null);

      const asked = await routeStage(routeInput({
        contextId,
        override: { model: "missing-model" },
      }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(asked.action, "ask_user");
      status = store.status(store.context({ cwd: project.root, contextId }));
      assert.equal(status.currentStage.state, "awaiting_user");
      assert.equal(status.currentStage.target, null);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
