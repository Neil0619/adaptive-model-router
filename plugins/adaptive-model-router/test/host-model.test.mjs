import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { RouterStore, normalizeRootModel } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

test("root-model intent is first-observation safe, exactly resolved, and task scoped", async () => {
  const project = await temporaryProject("adaptive host model ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "intent";
      const context = store.context({ cwd: project.root, contextId });
      const baseline = store.observeHostModel(context, "gpt-5.6-sol");
      assert.equal(baseline.changed, false);
      assert.equal(baseline.taskMode, "automatic");

      const first = await routeStage(routeInput({ contextId }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(first.schemaVersion, "3.0");
      assert.equal(first.taskMode, "automatic");
      assert.deepEqual(first.rootTask, {
        modelVisibility: "hook_observed",
        model: "gpt-5.6-sol",
        reasoningEffortVisibility: "host_only",
        changedByRouter: false,
      });

      const changed = store.observeHostModel(context, "gpt-5.6-terra");
      assert.equal(changed.taskMode, "pending_confirmation");
      const repeated = store.observeHostModel(context, "gpt-5.6-terra");
      assert.equal(repeated.pendingChange.changeId, changed.pendingChange.changeId);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM host_model_changes").get().count), 1);

      const pendingRoute = await routeStage(routeInput({ contextId }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(pendingRoute.action, "continue");
      assert.equal(pendingRoute.taskMode, "pending_confirmation");
      assert.ok(pendingRoute.reasonCodes.includes("HOST_MODEL_INTENT_PENDING"));
      assert.equal(pendingRoute.rootTask.model, "gpt-5.6-terra");

      const kept = await callRouterTool("resolve_host_model_intent", {
        contextId,
        changeId: changed.pendingChange.changeId,
        decision: "keep_automatic",
      }, { store, cwd: project.root });
      assert.equal(kept.resolved, true);
      assert.equal(kept.taskMode, "automatic");
      const duplicate = await callRouterTool("resolve_host_model_intent", {
        contextId,
        changeId: changed.pendingChange.changeId,
        decision: "keep_automatic",
      }, { store, cwd: project.root });
      assert.equal(duplicate.idempotent, true);
      await assert.rejects(
        callRouterTool("resolve_host_model_intent", {
          contextId,
          changeId: changed.pendingChange.changeId,
          decision: "manual_root",
        }, { store, cwd: project.root }),
        /conflicting decision/,
      );

      const next = await routeStage(routeInput({ contextId }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(next.action, "delegate");
      const secondChange = store.observeHostModel(context, "gpt-5.6-sol");
      await assert.rejects(
        callRouterTool("resolve_host_model_intent", {
          contextId,
          changeId: changed.pendingChange.changeId,
          decision: "keep_automatic",
        }, { store, cwd: project.root }),
        /stale/,
      );
      const manual = store.resolveHostModelIntent(context, {
        changeId: secondChange.pendingChange.changeId,
        decision: "manual_root",
      });
      assert.equal(manual.taskMode, "manual_root");
      const manualRoute = await routeStage(routeInput({ contextId }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(manualRoute.action, "continue");
      assert.ok(manualRoute.reasonCodes.includes("MANUAL_ROOT_SELECTED"));

      const other = await routeStage(routeInput({ contextId: "new-task" }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(other.taskMode, "automatic");
      assert.equal(other.action, "delegate");
      await assert.rejects(
        callRouterTool("resolve_host_model_intent", {
          contextId: "new-task",
          changeId: secondChange.pendingChange.changeId,
          decision: "manual_root",
        }, { store, cwd: project.root }),
        /does not belong/,
      );
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("pending changes supersede monotonically and reverting to the origin cancels confirmation", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "changes" });
      store.observeHostModel(context, "gpt-5.6-sol");
      const first = store.observeHostModel(context, "gpt-5.6-terra");
      const second = store.observeHostModel(context, "gpt-5.6-luna");
      assert.notEqual(second.pendingChange.changeId, first.pendingChange.changeId);
      assert.equal(second.pendingChange.fromModel, "gpt-5.6-sol");
      assert.equal(store.db.prepare("SELECT status FROM host_model_changes WHERE change_id = ?").get(first.pendingChange.changeId).status, "superseded");
      const reverted = store.observeHostModel(context, "gpt-5.6-sol");
      assert.equal(reverted.taskMode, "automatic");
      assert.equal(reverted.pendingChange, null);
      assert.equal(store.db.prepare("SELECT status FROM host_model_changes WHERE change_id = ?").get(second.pendingChange.changeId).status, "cancelled");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("root model slugs are allowlisted and effort-only host changes remain outside the contract", () => {
  assert.equal(normalizeRootModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(normalizeRootModel(" provider/model:preview "), "provider/model:preview");
  assert.equal(normalizeRootModel("gpt-5.6-sol\nsecret"), null);
  assert.equal(normalizeRootModel("../model"), null);
  assert.equal(normalizeRootModel("provider/model/../secret"), null);
  assert.equal(normalizeRootModel("C:/Users/person/private"), null);
  assert.equal(normalizeRootModel("file:/Users/person/private"), null);
  assert.equal(normalizeRootModel("sk-privacy-secret-1234567890"), null);
  assert.equal(normalizeRootModel(""), null);
});

test("missing or invalid current hook models display host-managed without losing the last valid baseline", async () => {
  const project = await temporaryProject("adaptive host visibility ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "visibility";
      const context = store.context({ cwd: project.root, contextId });
      store.observeHostModel(context, "gpt-5.6-sol");
      const invalid = store.observeHostModel(context, "gpt-5.6-sol\nsecret");
      assert.equal(invalid.observed, false);
      assert.equal(invalid.currentModel, "gpt-5.6-sol");
      assert.equal(invalid.modelVisible, false);
      assert.deepEqual(store.rootTask(context), {
        modelVisibility: "host_managed",
        reasoningEffortVisibility: "host_only",
        changedByRouter: false,
      });
      const hiddenRoute = await routeStage(routeInput({ contextId }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(hiddenRoute.rootTask.modelVisibility, "host_managed");
      const restored = store.observeHostModel(context, "gpt-5.6-sol");
      assert.equal(restored.changed, false);
      assert.equal(restored.modelVisible, true);
      const changed = store.observeHostModel(context, "gpt-5.6-terra");
      assert.equal(changed.taskMode, "pending_confirmation");
      assert.equal(changed.pendingChange.fromModel, "gpt-5.6-sol");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("database v1 migrates transactionally to v2 without losing routes, outcomes, or policy", async () => {
  const project = await temporaryProject("adaptive migration v1 ");
  try {
    await withRouterEnvironment(project, async () => {
      let store = new RouterStore();
      const route = await routeStage(routeInput({ contextId: "migration" }), { catalog: CATALOG, cwd: project.root, store });
      recordOutcome({
        routeId: route.routeId,
        contextId: "migration",
        status: "passed",
        gate: route.verificationGate,
        failureType: null,
        retries: 0,
        escalations: 0,
        userCorrection: false,
      }, { store, cwd: project.root });
      const revisionId = store.ensurePolicy(store.context({ cwd: project.root, contextId: "migration" })).revisionId;
      const database = store.path;
      store.close();

      const old = new DatabaseSync(database);
      old.exec(`
        DROP TABLE host_model_state;
        DROP TABLE host_model_changes;
        ALTER TABLE routes DROP COLUMN root_model;
        PRAGMA user_version = 1;
      `);
      old.close();

      store = new RouterStore({ path: database });
      assert.equal(Number(store.db.prepare("PRAGMA user_version").get().user_version), 2);
      assert.equal(store.db.prepare("SELECT count(*) AS count FROM routes").get().count, 1);
      assert.equal(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count, 1);
      assert.equal(store.db.prepare("SELECT active_revision_id FROM project_policy").get().active_revision_id, revisionId);
      assert.equal(store.db.prepare("PRAGMA table_info(routes)").all().some((column) => column.name === "root_model"), true);
      assert.doesNotThrow(() => store.db.prepare("SELECT * FROM host_model_state").all());
      const context = store.context({ cwd: project.root, contextId: "migration" });
      store.observeHostModel(context, "gpt-5.6-sol");
      store.close();

      const beta = new DatabaseSync(database);
      beta.exec("ALTER TABLE host_model_state DROP COLUMN model_visible; PRAGMA user_version = 2;");
      beta.close();
      store = new RouterStore({ path: database });
      assert.equal(store.db.prepare("PRAGMA table_info(host_model_state)").all().some((column) => column.name === "model_visible"), true);
      assert.equal(store.rootTask(store.context({ cwd: project.root, contextId: "migration" })).model, "gpt-5.6-sol");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("autoActivate is accepted globally and rejected at project scope", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const configured = await callRouterTool("configure_router", {
        contextId: "settings",
        scope: "global",
        autoActivate: true,
      }, { store, cwd: project.root });
      assert.equal(configured.autoActivate, true);
      await assert.rejects(
        callRouterTool("configure_router", {
          contextId: "settings",
          scope: "project",
          autoActivate: false,
        }, { store, cwd: project.root }),
        /global setting/,
      );
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
