import test from "node:test";
import assert from "node:assert/strict";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const SOL_TERRA_CAPABILITIES = {
  delegation: {
    available: true,
    targets: [
      { model: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { model: "gpt-5.6-terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ],
  },
};

const ALL_CAPABILITIES = {
  delegation: {
    available: true,
    targets: [
      ...SOL_TERRA_CAPABILITIES.delegation.targets,
      { model: "gpt-5.6-luna", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ],
  },
};

test("route actions cover continue, delegate, and ask_user", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const continued = await routeStage({ goal: "Hello!", phase: "conversation", evidence: {}, contextId: "a" }, { catalog: CATALOG, cwd: project.root });
      assert.equal(continued.action, "continue");
      assert.equal("target" in continued, false);

      const delegated = await routeStage(routeInput({
        goal: "Rename 100 fixture keys using the fixed mapping.",
        evidence: { workProduct: true, mechanical: true, requirementsSettled: true, batchSize: 100 },
        contextId: "b",
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(delegated.action, "delegate");
      assert.equal(delegated.target.model, "gpt-5.6-terra");
      assert.ok(delegated.reasonCodes.includes("MODEL_FAMILY_FALLBACK"));

      const asked = await routeStage(routeInput({ contextId: "c", override: { model: "missing-model" } }), { catalog: CATALOG, cwd: project.root });
      assert.equal(asked.action, "ask_user");
      assert.equal("target" in asked, false);
      assert.ok(asked.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));
    });
  } finally {
    await project.cleanup();
  }
});

test("override precedence is request then once, session, project, and optional global", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "priority" });
      store.configure(context, { allowGlobalOverride: true }, "project");
      store.setOverride(context, { scope: "global", model: "gpt-5.6-luna" });
      store.setOverride(context, { scope: "project", model: "gpt-5.6-terra" });
      store.setOverride(context, { scope: "session", model: "gpt-5.6-sol" });
      store.setOverride(context, { scope: "once", model: "gpt-5.6-luna", effort: "high" });

      const options = { catalog: CATALOG, cwd: project.root, store };
      const request = await routeStage(routeInput({ contextId: "priority", override: { model: "gpt-5.6-terra" }, hostCapabilities: ALL_CAPABILITIES }), options);
      assert.equal(request.target.model, "gpt-5.6-terra");
      const once = await routeStage(routeInput({ contextId: "priority", hostCapabilities: ALL_CAPABILITIES }), options);
      assert.equal(once.target.model, "gpt-5.6-luna");
      const session = await routeStage(routeInput({ contextId: "priority", hostCapabilities: ALL_CAPABILITIES }), options);
      assert.equal(session.target.model, "gpt-5.6-sol");
      store.clearOverrides(context, "session");
      const projectRoute = await routeStage(routeInput({ contextId: "priority", hostCapabilities: ALL_CAPABILITIES }), options);
      assert.equal(projectRoute.target.model, "gpt-5.6-terra");
      store.clearOverrides(context, "project");
      const globalRoute = await routeStage(routeInput({ contextId: "priority", hostCapabilities: ALL_CAPABILITIES }), options);
      assert.equal(globalRoute.target.model, "gpt-5.6-luna");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("delegation capabilities are independent from root catalog and validate strictly", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const automatic = await routeStage(routeInput({
        goal: "Rename 100 fixture keys using the fixed mapping.",
        evidence: { workProduct: true, mechanical: true, requirementsSettled: true, batchSize: 100 },
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(automatic.target.model, "gpt-5.6-terra");
      assert.ok(automatic.reasonCodes.includes("MODEL_FAMILY_FALLBACK"));

      const lunaEnabled = await routeStage(routeInput({
        contextId: "luna-enabled",
        goal: "Rename 100 fixture keys using the fixed mapping.",
        evidence: { workProduct: true, mechanical: true, requirementsSettled: true, batchSize: 100 },
        hostCapabilities: ALL_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(lunaEnabled.target.model, "gpt-5.6-luna");

      await assert.rejects(
        routeStage(routeInput({
          contextId: "capability-conflict",
          evidence: { workProduct: true, hostCanDelegate: false },
          hostCapabilities: SOL_TERRA_CAPABILITIES,
        }), { catalog: CATALOG, cwd: project.root }),
        /conflicts/,
      );
      await assert.rejects(
        routeStage(routeInput({
          contextId: "capability-duplicate",
          hostCapabilities: { delegation: { available: true, targets: [
            { model: "gpt-5.6-sol", efforts: ["high", "high"] },
          ] } },
        }), { catalog: CATALOG, cwd: project.root }),
        /must not duplicate/,
      );
      await assert.rejects(
        routeStage(routeInput({
          contextId: "capability-unavailable-with-target",
          hostCapabilities: {
            delegation: {
              available: false,
              targets: [{ model: "gpt-5.6-sol", efforts: ["high"] }],
            },
          },
        }), { catalog: CATALOG, cwd: project.root }),
        /must be empty/,
      );
      await assert.rejects(
        routeStage(routeInput({
          contextId: "capability-invalid-effort",
          hostCapabilities: {
            delegation: {
              available: true,
              targets: [{ model: "gpt-5.6-sol", efforts: ["impossible"] }],
            },
          },
        }), { catalog: CATALOG, cwd: project.root }),
        /must be one of/,
      );
      const unavailable = await routeStage(routeInput({
        contextId: "capability-unavailable",
        hostCapabilities: { delegation: { available: false, targets: [] } },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(unavailable.action, "continue");
      assert.ok(unavailable.reasonCodes.includes("HOST_DELEGATION_UNAVAILABLE"));
    });
  } finally {
    await project.cleanup();
  }
});

test("explicit unavailable Luna asks without consuming a once override", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "once-luna" });
      store.setOverride(context, { scope: "once", model: "gpt-5.6-luna" });
      const unavailable = await routeStage(routeInput({
        contextId: "once-luna",
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(unavailable.action, "ask_user");
      assert.ok(unavailable.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));

      const enabled = await routeStage(routeInput({
        contextId: "once-luna",
        hostCapabilities: ALL_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(enabled.action, "delegate");
      assert.equal(enabled.target.model, "gpt-5.6-luna");
      assert.ok(enabled.reasonCodes.includes("ONCE_OVERRIDE"));
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("tooling failures retry one automatic target but never replace an explicit target", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const first = await routeStage(routeInput({ contextId: "tooling", hostCapabilities: SOL_TERRA_CAPABILITIES }), { catalog: CATALOG, cwd: project.root });
      assert.equal(first.target.model, "gpt-5.6-terra");
      const retry = await routeStage(routeInput({
        contextId: "tooling",
        previousRouteId: first.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "tooling" },
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(retry.action, "delegate");
      assert.equal(retry.target.model, "gpt-5.6-sol");
      assert.ok(retry.reasonCodes.includes("TOOLING_TARGET_EXCLUDED"));
      const exhausted = await routeStage(routeInput({
        contextId: "tooling",
        previousRouteId: retry.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "tooling" },
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(exhausted.action, "continue");
      assert.ok(exhausted.reasonCodes.includes("HOST_DELEGATION_UNAVAILABLE"));

      const explicit = await routeStage(routeInput({
        contextId: "tooling-explicit",
        override: { model: "gpt-5.6-terra" },
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root });
      const explicitRetry = await routeStage(routeInput({
        contextId: "tooling-explicit",
        previousRouteId: explicit.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "tooling" },
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(explicitRetry.action, "ask_user");
      assert.ok(explicitRetry.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));
    });
  } finally {
    await project.cleanup();
  }
});

test("declared delegation targets remain authoritative when the root catalog is unavailable", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const result = await routeStage(routeInput({
        contextId: "capability-without-root-catalog",
        hostCapabilities: SOL_TERRA_CAPABILITIES,
      }), { catalog: [], cwd: project.root });
      assert.equal(result.action, "delegate");
      assert.equal(result.target.model, "gpt-5.6-terra");
    });
  } finally {
    await project.cleanup();
  }
});

test("once override is not consumed by continue or ask_user", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "once" });
      store.setOverride(context, { scope: "once", model: "gpt-5.6-sol" });
      const continued = await routeStage(routeInput({ contextId: "once", evidence: { workProduct: true, hostCanDelegate: false } }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(continued.action, "continue");
      const delegated = await routeStage(routeInput({ contextId: "once" }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(delegated.target.model, "gpt-5.6-sol");
      assert.ok(delegated.reasonCodes.includes("ONCE_OVERRIDE"));
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("explicit unsupported effort asks instead of silently changing effort", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const catalog = [{ slug: "gpt-5.6-terra", visibility: "list", supported_reasoning_levels: ["high"] }];
      const result = await routeStage(routeInput({ override: { model: "gpt-5.6-terra", effort: "medium" } }), { catalog, cwd: project.root });
      assert.equal(result.action, "ask_user");
      assert.ok(result.reasonCodes.includes("EXPLICIT_TARGET_UNAVAILABLE"));
    });
  } finally {
    await project.cleanup();
  }
});

test("hidden and unknown models are never selected automatically", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const result = await routeStage(routeInput(), { catalog: [
        { slug: "gpt-5.6-sol", visibility: "hide", supported_reasoning_levels: ["high"] },
        { slug: "future-unknown", visibility: "list", priority: 0, supported_reasoning_levels: ["high"] },
      ], cwd: project.root });
      assert.equal(result.action, "continue");
      assert.ok(result.reasonCodes.includes("CATALOG_UNAVAILABLE"));
    });
  } finally {
    await project.cleanup();
  }
});

test("reasoning escalation is monotonic and asks after two automatic escalations", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const first = await routeStage(routeInput({ contextId: "escalate", override: { model: "gpt-5.6-terra", effort: "high" } }), { catalog: CATALOG, cwd: project.root });
      const second = await routeStage(routeInput({
        contextId: "escalate",
        previousRouteId: first.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "reasoning" },
      }), { catalog: CATALOG, cwd: project.root });
      assert.ok(["max", "xhigh", "ultra"].includes(second.target.effort));
      assert.equal(second.escalation.count, 1);
      const third = await routeStage(routeInput({
        contextId: "escalate",
        previousRouteId: second.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "reasoning" },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(third.target.model, "gpt-5.6-sol");
      assert.ok(["xhigh", "max", "ultra"].includes(third.target.effort));
      assert.equal(third.escalation.count, 2);
      const exhausted = await routeStage(routeInput({
        contextId: "escalate",
        previousRouteId: third.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "reasoning" },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(exhausted.action, "ask_user");
      assert.ok(exhausted.reasonCodes.includes("ESCALATION_LIMIT_REACHED"));
    });
  } finally {
    await project.cleanup();
  }
});

test("environment failure holds effort and previousRouteId is project/context bound", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const first = await routeStage(routeInput({ contextId: "bound", override: { model: "gpt-5.6-sol", effort: "xhigh" } }), { catalog: CATALOG, cwd: project.root });
      const held = await routeStage(routeInput({
        contextId: "bound", previousRouteId: first.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "environment" },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(held.target.effort, "xhigh");
      assert.equal(held.escalation.state, "held");
      await assert.rejects(
        routeStage(routeInput({ contextId: "other", previousRouteId: first.routeId }), { catalog: CATALOG, cwd: project.root }),
        /does not belong/,
      );
    });
  } finally {
    await project.cleanup();
  }
});

test("an ultra route never downgrades to max/high when no stronger automatic escalation exists", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const first = await routeStage(routeInput({ contextId: "ultra", override: { model: "gpt-5.6-sol", effort: "ultra" } }), { catalog: CATALOG, cwd: project.root });
      const retry = await routeStage(routeInput({
        contextId: "ultra",
        previousRouteId: first.routeId,
        evidence: { workProduct: true, verificationFailed: true, failureType: "reasoning" },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(retry.action, "ask_user");
      assert.equal("target" in retry, false);
      assert.ok(retry.reasonCodes.includes("MONOTONIC_ESCALATION_UNAVAILABLE"));
    });
  } finally {
    await project.cleanup();
  }
});

test("route input rejects forged category and risk floor always selects Sol high or stronger", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      await assert.rejects(
        routeStage({ ...routeInput(), category: "mechanical" }, { catalog: CATALOG, cwd: project.root }),
        /not allowed/,
      );
      const result = await routeStage(routeInput({
        goal: "Migrate authentication state safely.",
        evidence: { workProduct: true, highRisk: true, securitySensitive: true, migration: true },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(result.target.model, "gpt-5.6-sol");
      assert.ok(["high", "xhigh", "max", "ultra"].includes(result.target.effort));
    });
  } finally {
    await project.cleanup();
  }
});

test("a negative auxiliary-classifier adjustment cannot penetrate the deterministic risk floor", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      try {
        const result = await routeStage(routeInput({
          goal: "Implement a sensitive production change.",
          contextId: "risk-classifier",
          evidence: { workProduct: true, highRisk: true, crossCutting: true, strongVerification: true },
        }), {
          catalog: CATALOG,
          cwd: project.root,
          appServer: async (run) => run({
            listModels: async () => CATALOG,
            classify: async ({ model }) => {
              assert.equal(model, "gpt-5.6-luna");
              return {
                complexityAdjustment: -10,
                category: "implementation",
                confidence: 0.9,
                reasonCodes: ["CLASSIFIER_COMPLEXITY_DOWN"],
              };
            },
          }),
        });
        assert.equal(result.classifier.state, "used");
        assert.equal(result.target.model, "gpt-5.6-sol");
        assert.ok(["high", "max", "xhigh", "ultra"].includes(result.target.effort));
      } finally {
        if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
        else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
      }
    });
  } finally {
    await project.cleanup();
  }
});
