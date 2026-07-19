import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { RouterStore } from "../scripts/lib/database.mjs";
import {
  approvePolicyProposal,
  listPolicyProposals,
  recordOutcome,
  rejectPolicyProposal,
  rollbackPolicy,
} from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

async function createRoute(store, cwd, contextId, goal = "Implement the specified parser with targeted tests.") {
  return routeStage(routeInput({ goal, contextId }), { catalog: CATALOG, cwd, store });
}

function outcomeFor(route, contextId, overrides = {}) {
  const status = overrides.status || "passed";
  return {
    routeId: route.routeId,
    contextId,
    status,
    gate: route.verificationGate,
    failureType: status === "failed" ? "reasoning" : null,
    retries: 0,
    escalations: route.escalation.count,
    userCorrection: false,
    ...overrides,
  };
}

test("record_outcome rejects permissive strings and inconsistent failure fields", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const route = await createRoute(store, project.root, "strict");
      assert.throws(() => recordOutcome({ ...outcomeFor(route, "strict"), status: "not passed" }, { store, cwd: project.root }), /one of/);
      assert.throws(() => recordOutcome({ ...outcomeFor(route, "strict"), status: "not ok" }, { store, cwd: project.root }), /one of/);
      assert.throws(() => recordOutcome({ ...outcomeFor(route, "strict"), status: "passed", failureType: "reasoning" }, { store, cwd: project.root }), /failureType null/);
      assert.throws(() => recordOutcome({ ...outcomeFor(route, "strict"), status: "failed", failureType: null }, { store, cwd: project.root }), /require failureType/);
      assert.throws(() => recordOutcome({ ...outcomeFor(route, "strict"), extra: true }, { store, cwd: project.root }), /not allowed/);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("outcomes are exactly-once: identical is idempotent and conflicting is rejected", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const route = await createRoute(store, project.root, "idempotent");
      const outcome = outcomeFor(route, "idempotent");
      assert.equal(recordOutcome(outcome, { store, cwd: project.root }).recorded, true);
      assert.equal(recordOutcome(outcome, { store, cwd: project.root }).idempotent, true);
      assert.throws(
        () => recordOutcome({ ...outcome, status: "failed", failureType: "reasoning" }, { store, cwd: project.root }),
        /conflicting final outcome/,
      );
      const count = store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count;
      assert.equal(Number(count), 1);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("unknown outcomes never enter the learning window", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      for (let index = 0; index < 21; index += 1) {
        const route = await createRoute(store, project.root, "unknown", `Implement parser variant ${index} with tests.`);
        recordOutcome(outcomeFor(route, "unknown", { status: "unknown" }), { store, cwd: project.root });
      }
      assert.deepEqual(listPolicyProposals({ contextId: "unknown" }, { store, cwd: project.root }), []);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("+5 proposal requires 12 eligible results and four distinct affected results", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      for (let index = 0; index < 11; index += 1) {
        const route = await createRoute(store, project.root, "plus", `Implement parser case ${index} with tests.`);
        const failed = index < 4;
        recordOutcome(outcomeFor(route, "plus", failed ? { status: "failed", retries: index === 0 ? 1 : 0 } : {}), { store, cwd: project.root });
      }
      assert.equal(listPolicyProposals({ contextId: "plus" }, { store, cwd: project.root }).length, 0);
      const route = await createRoute(store, project.root, "plus", "Implement parser case twelve with tests.");
      recordOutcome(outcomeFor(route, "plus"), { store, cwd: project.root });
      const proposals = listPolicyProposals({ contextId: "plus" }, { store, cwd: project.root });
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].delta, 5);
      assert.equal(proposals[0].eligibleCount, 12);
      assert.equal(proposals[0].affectedCount, 4);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("-5 proposal requires 20 completely clean eligible results", async () => {
  const project = await temporaryProject();
  const cleanProject = `${project.root}/clean-project`;
  await mkdir(cleanProject);
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      for (let index = 0; index < 19; index += 1) {
        const route = await createRoute(store, cleanProject, "minus", `Document specified option ${index}.`);
        recordOutcome(outcomeFor(route, "minus"), { store, cwd: cleanProject });
      }
      assert.equal(listPolicyProposals({ contextId: "minus" }, { store, cwd: cleanProject }).length, 0);
      const route = await createRoute(store, cleanProject, "minus", "Document specified option twenty.");
      recordOutcome(outcomeFor(route, "minus"), { store, cwd: cleanProject });
      const proposals = listPolicyProposals({ contextId: "minus" }, { store, cwd: cleanProject });
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].delta, -5);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("reject and approve are idempotent and advance evidence windows", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      for (let index = 0; index < 12; index += 1) {
        const route = await createRoute(store, project.root, "decision", `Implement decision case ${index} with tests.`);
        recordOutcome(outcomeFor(route, "decision", index < 4 ? { status: "failed" } : {}), { store, cwd: project.root });
      }
      const proposal = listPolicyProposals({ contextId: "decision" }, { store, cwd: project.root })[0];
      const rejected = rejectPolicyProposal({ contextId: "decision", proposalId: proposal.proposalId }, { store, cwd: project.root });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejectPolicyProposal({ contextId: "decision", proposalId: proposal.proposalId }, { store, cwd: project.root }).idempotent, true);
      for (let index = 0; index < 3; index += 1) {
        const route = await createRoute(store, project.root, "decision", `Implement later case ${index} with tests.`);
        recordOutcome(outcomeFor(route, "decision", { status: "failed" }), { store, cwd: project.root });
      }
      assert.equal(listPolicyProposals({ contextId: "decision" }, { store, cwd: project.root }).length, 0);

      const context = store.context({ cwd: project.root, contextId: "decision" });
      const active = store.ensurePolicy(context);
      const proposalId = randomUUID();
      store.db.prepare(`
        INSERT INTO policy_proposals(
          proposal_id, project_id, category, delta, base_revision_id, start_seq, end_seq,
          eligible_count, affected_count, status, created_at
        ) VALUES(?, ?, 'review', 5, ?, 1, 1, 12, 4, 'pending', ?)
      `).run(proposalId, context.projectId, active.revisionId, new Date().toISOString());
      const approved = approvePolicyProposal({ contextId: "decision", proposalId }, { store, cwd: project.root });
      assert.equal(approved.status, "approved");
      assert.equal(approvePolicyProposal({ contextId: "decision", proposalId }, { store, cwd: project.root }).idempotent, true);
      const revisions = Number(store.db.prepare("SELECT count(*) AS count FROM policy_revisions WHERE project_id = ?").get(context.projectId).count);
      assert.equal(revisions, 2);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("continuous rollback follows immutable parent revisions without bouncing", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "rollback" });
      const revisionA = store.ensurePolicy(context).revisionId;
      const revisionB = randomUUID();
      const revisionC = randomUUID();
      store.transaction(() => {
        store.db.prepare(`INSERT INTO policy_revisions(revision_id, project_id, parent_revision_id, offsets_json, outcome_seq, created_at) VALUES(?, ?, ?, '{}', 0, ?)`)
          .run(revisionB, context.projectId, revisionA, new Date().toISOString());
        store.db.prepare(`INSERT INTO policy_revisions(revision_id, project_id, parent_revision_id, offsets_json, outcome_seq, created_at) VALUES(?, ?, ?, '{}', 0, ?)`)
          .run(revisionC, context.projectId, revisionB, new Date().toISOString());
        store.db.prepare("UPDATE project_policy SET active_revision_id = ? WHERE project_id = ?").run(revisionC, context.projectId);
      });
      assert.equal(rollbackPolicy({ contextId: "rollback" }, { store, cwd: project.root }).revisionId, revisionB);
      assert.equal(rollbackPolicy({ contextId: "rollback" }, { store, cwd: project.root }).revisionId, revisionA);
      assert.equal(rollbackPolicy({ contextId: "rollback" }, { store, cwd: project.root }).rolledBack, false);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
