import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

test("SQLite files and redacted status contain no prompt, source, absolute path, context id, or secret", async () => {
  const project = await temporaryProject("adaptive privacy Unicode 私密 ");
  const secret = "sk-privacy-secret-1234567890";
  const contextId = "private-session-name";
  const source = "function superPrivateSourceName() { return 42; }";
  const goal = `Implement ${source} in ${project.root} with token ${secret}`;
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const route = await routeStage(routeInput({ goal, contextId }), { catalog: CATALOG, cwd: project.root, store });
      recordOutcome({
        routeId: route.routeId,
        contextId,
        status: "passed",
        gate: route.verificationGate,
        failureType: null,
        retries: 0,
        escalations: route.escalation.count,
        userCorrection: false,
      }, { store, cwd: project.root });
      const context = store.context({ cwd: project.root, contextId });
      const publicState = JSON.stringify({
        status: store.status(context),
        history: store.routeHistory(context),
        diagnose: store.diagnose(context),
      });
      for (const forbidden of [goal, source, project.root, contextId, secret]) assert.equal(publicState.includes(forbidden), false, forbidden);
      store.close();

      const stateFiles = await readdir(project.home);
      assert.ok(stateFiles.some((name) => name.endsWith(".sqlite3")));
      for (const name of stateFiles.filter((candidate) => /sqlite3(?:-wal|-shm)?$/.test(candidate))) {
        const data = await readFile(join(project.home, name));
        for (const forbidden of [goal, source, project.root, contextId, secret]) {
          assert.equal(data.includes(Buffer.from(forbidden)), false, `${name} contains ${forbidden}`);
        }
      }
    });
  } finally {
    await project.cleanup();
  }
});

test("status is current-context only and clear_project_data requires confirmation and preserves other projects plus salt", async () => {
  const project = await temporaryProject();
  const other = join(project.root, "other-project");
  await mkdir(other);
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const routeA = await routeStage(routeInput({ contextId: "context-a", override: { model: "gpt-5.6-sol" } }), { catalog: CATALOG, cwd: project.root, store });
      const routeB = await routeStage(routeInput({ contextId: "context-b", override: { model: "gpt-5.6-luna" } }), { catalog: CATALOG, cwd: project.root, store });
      await routeStage(routeInput({ contextId: "other", override: { model: "gpt-5.6-terra" } }), { catalog: CATALOG, cwd: other, store });
      const statusA = await callRouterTool("get_route_status", { contextId: "context-a" }, { store, cwd: project.root });
      assert.equal(statusA.latestRoute.routeId, routeA.routeId);
      assert.notEqual(statusA.latestRoute.routeId, routeB.routeId);
      const historyA = await callRouterTool("get_route_history", { contextId: "context-a" }, { store, cwd: project.root });
      assert.deepEqual(historyA.routes.map((route) => route.routeId), [routeA.routeId]);

      const salt = store.db.prepare("SELECT value FROM meta WHERE key = 'local_salt'").get().value;
      await assert.rejects(
        callRouterTool("clear_project_data", { contextId: "context-a", confirm: "wrong" }, { store, cwd: project.root }),
        /one of/,
      );
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 3);
      await callRouterTool("clear_project_data", { contextId: "context-a", confirm: "CLEAR_PROJECT_DATA" }, { store, cwd: project.root });
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 1);
      assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'local_salt'").get().value, salt);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("doctor reports legacy presence without returning legacy paths or content", async () => {
  const project = await temporaryProject();
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = join(project.root, "Codex Legacy Home");
  process.env.CODEX_HOME = codexHome;
  await mkdir(join(codexHome, "adaptive-model-router"), { recursive: true });
  await writeFile(join(codexHome, "adaptive-model-router", "settings.json"), JSON.stringify({ enabled: true, secret: "legacy-secret" }));
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "doctor" });
      const diagnosis = store.diagnose(context);
      const serialized = JSON.stringify(diagnosis);
      assert.equal(diagnosis.legacyState.present, true);
      assert.equal(diagnosis.legacyState.automaticallyImported, false);
      assert.doesNotMatch(serialized, /legacy-secret|Codex Legacy Home|settings\.json/);
      store.close();
    });
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await project.cleanup();
  }
});
