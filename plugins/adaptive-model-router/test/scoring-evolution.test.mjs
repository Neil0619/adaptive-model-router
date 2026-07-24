import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_SCORING_PROFILE, SCHEMA_VERSION } from "../scripts/lib/constants.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const ZERO_RETRIES = { reasoning: 0, environment: 0, information: 0, tooling: 0 };

function profileDefinition(overrides = {}) {
  return {
    weights: { ...DEFAULT_SCORING_PROFILE.weights, ...(overrides.weights || {}) },
    thresholds: { ...DEFAULT_SCORING_PROFILE.thresholds, ...(overrides.thresholds || {}) },
  };
}

function passedOutcome(route, contextId) {
  return {
    routeId: route.routeId,
    contextId,
    status: "passed",
    gate: route.verificationGate,
    failureType: null,
    retries: 0,
    retryBreakdown: ZERO_RETRIES,
    escalations: route.escalation.count,
    userCorrection: false,
  };
}

test("database v3 stores redacted immutable score snapshots and excludes overrides from learning", async () => {
  const project = await temporaryProject("adaptive scoring snapshots ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const privateMarker = "do-not-store-this-prompt-marker";
      const automatic = await routeStage(routeInput({
        contextId: "snapshot-auto",
        goal: `Implement the specified parser with tests ${privateMarker}.`,
      }), { catalog: CATALOG, cwd: project.root, store });
      const explicit = await routeStage(routeInput({
        contextId: "snapshot-explicit",
        override: { model: "gpt-5.6-terra", effort: "medium" },
      }), { catalog: CATALOG, cwd: project.root, store });
      const automaticRow = store.db.prepare(`
        SELECT * FROM route_score_snapshots WHERE route_id = ?
      `).get(automatic.routeId);
      const explicitRow = store.db.prepare(`
        SELECT * FROM route_score_snapshots WHERE route_id = ?
      `).get(explicit.routeId);
      assert.equal(Number(store.db.prepare("PRAGMA user_version").get().user_version), 3);
      assert.equal(automaticRow.eligible_learning, 1);
      assert.equal(explicitRow.eligible_learning, 0);
      assert.deepEqual(JSON.parse(explicitRow.exclusion_codes_json), ["OVERRIDE_APPLIED"]);
      assert.equal(JSON.stringify(automaticRow).includes(privateMarker), false);
      assert.equal(JSON.stringify(automaticRow).includes(project.root), false);
      const profile = store.ensureScoringProfile(store.context({ cwd: project.root, contextId: "snapshot-auto" }));
      assert.equal(automaticRow.profile_id, profile.profileId);
      assert.equal(profile.profileVersion, 1);
      recordOutcome(passedOutcome(automatic, "snapshot-auto"), { store, cwd: project.root });
      const status = await callRouterTool("get_learning_status", {
        contextId: "snapshot-auto",
      }, { store, cwd: project.root });
      assert.equal(status.scoringProfile.profileId, profile.profileId);
      assert.equal(status.evidence.outcomes, 1);
      assert.equal(status.evidence.snapshotted, 1);
      assert.equal(status.evidence.routeEligible, 1);

      const environmentRoute = await routeStage(routeInput({
        contextId: "snapshot-environment",
      }), { catalog: CATALOG, cwd: project.root, store });
      recordOutcome({
        routeId: environmentRoute.routeId,
        contextId: "snapshot-environment",
        status: "failed",
        gate: environmentRoute.verificationGate,
        failureType: "environment",
        retries: 1,
        retryBreakdown: { reasoning: 0, environment: 1, information: 0, tooling: 0 },
        escalations: environmentRoute.escalation.count,
        userCorrection: false,
      }, { store, cwd: project.root });
      const afterEnvironment = store.learningStatus(
        store.context({ cwd: project.root, contextId: "snapshot-auto" }),
      );
      assert.equal(afterEnvironment.evidence.outcomes, 2);
      assert.equal(afterEnvironment.evidence.routeEligible, 1);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("shadow scoring is deterministic and creates no route, outcome, proposal, or cursor", async () => {
  const project = await temporaryProject("adaptive shadow scoring ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const before = {
        projects: Number(store.db.prepare("SELECT count(*) AS count FROM projects").get().count),
        profiles: Number(store.db.prepare("SELECT count(*) AS count FROM scoring_profiles").get().count),
        policies: Number(store.db.prepare("SELECT count(*) AS count FROM policy_revisions").get().count),
        routes: Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count),
        outcomes: Number(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count),
        proposals: Number(store.db.prepare("SELECT count(*) AS count FROM policy_proposals").get().count),
        cursors: Number(store.db.prepare("SELECT count(*) AS count FROM learning_cursors").get().count),
      };
      const result = await callRouterTool("shadow_route_stage", {
        contextId: "shadow",
        goal: "Review a cross-module public authentication contract.",
        phase: "review",
        evidence: {
          workProduct: true,
          review: true,
          highRisk: true,
          securitySensitive: true,
          crossCutting: true,
          publicContract: true,
        },
        definition: profileDefinition(),
      }, { store, cwd: project.root });
      assert.equal(result.shadow, true);
      assert.equal(result.sideEffects, false);
      assert.deepEqual(result.preferred, { action: "delegate", family: "sol", effort: "max" });
      const after = {
        projects: Number(store.db.prepare("SELECT count(*) AS count FROM projects").get().count),
        profiles: Number(store.db.prepare("SELECT count(*) AS count FROM scoring_profiles").get().count),
        policies: Number(store.db.prepare("SELECT count(*) AS count FROM policy_revisions").get().count),
        routes: Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count),
        outcomes: Number(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count),
        proposals: Number(store.db.prepare("SELECT count(*) AS count FROM policy_proposals").get().count),
        cursors: Number(store.db.prepare("SELECT count(*) AS count FROM learning_cursors").get().count),
      };
      assert.deepEqual(after, before);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("classifier-adjusted and escalated routes are quarantined from online learning", async () => {
  const project = await temporaryProject("adaptive learning quarantine ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      let classified;
      try {
        classified = await routeStage(routeInput({
          contextId: "classifier-quarantine",
        }), {
          catalog: CATALOG,
          cwd: project.root,
          store,
          appServer: async (run) => run({
            listModels: async () => CATALOG,
            classify: async () => ({
              complexityAdjustment: 10,
              category: "implementation",
              confidence: 0.9,
              reasonCodes: ["CLASSIFIER_COMPLEXITY_UP"],
            }),
          }),
        });
      } finally {
        if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
        else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
      }
      const classifiedSnapshot = store.db.prepare(`
        SELECT eligible_learning, exclusion_codes_json
        FROM route_score_snapshots WHERE route_id = ?
      `).get(classified.routeId);
      assert.equal(classifiedSnapshot.eligible_learning, 0);
      assert.ok(JSON.parse(classifiedSnapshot.exclusion_codes_json).includes("CLASSIFIER_ADJUSTED"));

      const first = await routeStage(routeInput({
        contextId: "escalation-quarantine",
      }), { catalog: CATALOG, cwd: project.root, store });
      const escalated = await routeStage(routeInput({
        contextId: "escalation-quarantine",
        previousRouteId: first.routeId,
        evidence: {
          workProduct: true,
          verificationFailed: true,
          failureType: "reasoning",
        },
      }), { catalog: CATALOG, cwd: project.root, store });
      const escalatedSnapshot = store.db.prepare(`
        SELECT eligible_learning, exclusion_codes_json
        FROM route_score_snapshots WHERE route_id = ?
      `).get(escalated.routeId);
      assert.equal(escalatedSnapshot.eligible_learning, 0);
      assert.ok(JSON.parse(escalatedSnapshot.exclusion_codes_json).includes("ESCALATED_ROUTE"));
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("offline profiles are immutable and a hard risk-floor violation rolls back automatically", async () => {
  const project = await temporaryProject("adaptive profile rollback ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const contextId = "profile";
      const context = store.context({ cwd: project.root, contextId });
      const baseline = store.ensureScoringProfile(context);
      const reanchored = await callRouterTool("reanchor_scoring_profile", {
        contextId,
        profileVersion: 2,
        definition: profileDefinition({ weights: { ambiguity: 20 } }),
        confirm: "REANCHOR_SCORING_PROFILE",
      }, { store, cwd: project.root });
      assert.equal(reanchored.parentProfileId, baseline.profileId);
      assert.equal(store.ensureScoringProfile(context).profileVersion, 2);
      await assert.rejects(
        callRouterTool("reanchor_scoring_profile", {
          contextId,
          profileVersion: 2,
          definition: profileDefinition(),
          confirm: "REANCHOR_SCORING_PROFILE",
        }, { store, cwd: project.root }),
        /greater than/,
      );

      const routeId = randomUUID();
      const unsafeRoute = {
        schemaVersion: SCHEMA_VERSION,
        routeId,
        action: "delegate",
        category: "implementation",
        reasonCodes: ["DEFAULT_POLICY"],
        verificationGate: "full-checks",
        classifier: { state: "not_needed" },
        escalation: { state: "none", count: 0, limit: 2 },
        family: "terra",
        target: { model: "gpt-5.6-terra", effort: "low" },
        previousRouteId: null,
        rootTask: store.rootTask(context),
        taskMode: "automatic",
        scoringSnapshot: {
          profileId: reanchored.profileId,
          baseScore: 90,
          finalScore: 90,
          signals: { risk: true, security: true, migration: false },
          policyOffset: 0,
          classifierAdjustment: 0,
          hardSignalCount: 2,
          desiredFamily: "terra",
          desiredEffort: "low",
          eligibleLearning: true,
          exclusionCodes: [],
        },
      };
      assert.equal(store.commitRoute(context, unsafeRoute).committed, true);
      const result = recordOutcome({
        routeId,
        contextId,
        status: "passed",
        gate: "full-checks",
        failureType: null,
        retries: 0,
        retryBreakdown: ZERO_RETRIES,
        escalations: 0,
        userCorrection: false,
      }, { store, cwd: project.root });
      assert.equal(result.safety.rolledBack, true);
      assert.equal(store.ensureScoringProfile(context).profileId, baseline.profileId);
      const learning = store.learningStatus(context);
      assert.equal(learning.events[0].type, "safety_auto_rollback");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
