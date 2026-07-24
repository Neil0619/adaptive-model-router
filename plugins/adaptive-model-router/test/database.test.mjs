import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RouterStore } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { CATALOG, routeInput, temporaryProject } from "./fixtures.mjs";

test("writer timeout makes route fail open, outcome fail explicitly, and storage recover after lock release", async () => {
  const project = await temporaryProject();
  const database = join(project.home, "router.sqlite3");
  try {
    const owner = new RouterStore({ path: database, timeout: 25 });
    const contender = new RouterStore({ path: database, timeout: 25 });
    const initial = await routeStage(routeInput({ contextId: "lock" }), { catalog: CATALOG, cwd: project.root, store: contender });
    assert.equal(initial.action, "delegate");
    owner.db.exec("BEGIN IMMEDIATE");
    try {
      const degraded = await routeStage(routeInput({ contextId: "lock-2" }), { catalog: CATALOG, cwd: project.root, store: contender });
      assert.equal(degraded.action, "continue");
      assert.deepEqual(degraded.reasonCodes, ["STORAGE_UNAVAILABLE"]);
      assert.throws(() => recordOutcome({
        routeId: initial.routeId,
        contextId: "lock",
        status: "passed",
        gate: initial.verificationGate,
        failureType: null,
        retries: 0,
        retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
        escalations: initial.escalation.count,
        userCorrection: false,
      }, { store: contender, cwd: project.root }), /locked|busy/i);
    } finally {
      owner.db.exec("ROLLBACK");
    }
    const outcome = recordOutcome({
      routeId: initial.routeId,
      contextId: "lock",
      status: "passed",
      gate: initial.verificationGate,
      failureType: null,
      retries: 0,
      retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
      escalations: initial.escalation.count,
      userCorrection: false,
    }, { store: contender, cwd: project.root });
    assert.equal(outcome.recorded, true);
    assert.equal(contender.diagnose(contender.context({ cwd: project.root, contextId: "lock" })).databaseHealth, "ok");
    owner.close();
    contender.close();
  } finally {
    await project.cleanup();
  }
});

test("storage contract accepts additive future schemas and rejects incompatible newer databases", async () => {
  const project = await temporaryProject();
  const compatiblePath = join(project.home, "forward-compatible.sqlite3");
  const incompatiblePath = join(project.home, "incompatible.sqlite3");
  try {
    const initial = new RouterStore({ path: compatiblePath });
    initial.close();
    const future = new DatabaseSync(compatiblePath);
    future.exec("CREATE TABLE future_additive_feature(id TEXT PRIMARY KEY)");
    future.exec("PRAGMA user_version = 4");
    future.close();

    const compatible = new RouterStore({ path: compatiblePath });
    const context = compatible.context({ cwd: project.root, contextId: "forward" });
    const diagnosis = compatible.diagnose(context);
    assert.equal(diagnosis.databaseVersion, 4);
    assert.equal(diagnosis.supportedDatabaseVersion, 3);
    assert.equal(diagnosis.storageContractVersion, 1);
    assert.equal(diagnosis.databaseCompatibility, "forward_compatible");
    compatible.close();

    const incompatible = new DatabaseSync(incompatiblePath);
    incompatible.exec("CREATE TABLE unrelated(id TEXT PRIMARY KEY)");
    incompatible.exec("PRAGMA user_version = 4");
    incompatible.close();
    assert.throws(
      () => new RouterStore({ path: incompatiblePath }),
      /storage contract is incompatible/,
    );
  } finally {
    await project.cleanup();
  }
});
