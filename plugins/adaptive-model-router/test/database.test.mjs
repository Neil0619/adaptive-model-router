import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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
