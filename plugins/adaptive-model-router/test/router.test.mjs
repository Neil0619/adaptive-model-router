import test from "node:test";
import assert from "node:assert/strict";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

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
      assert.equal(delegated.target.model, "gpt-5.6-luna");

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

      const request = await routeStage(routeInput({ contextId: "priority", override: { model: "gpt-5.6-terra" } }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(request.target.model, "gpt-5.6-terra");
      const once = await routeStage(routeInput({ contextId: "priority" }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(once.target.model, "gpt-5.6-luna");
      const session = await routeStage(routeInput({ contextId: "priority" }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(session.target.model, "gpt-5.6-sol");
      store.clearOverrides(context, "session");
      const projectRoute = await routeStage(routeInput({ contextId: "priority" }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(projectRoute.target.model, "gpt-5.6-terra");
      store.clearOverrides(context, "project");
      const globalRoute = await routeStage(routeInput({ contextId: "priority" }), { catalog: CATALOG, cwd: project.root, store });
      assert.equal(globalRoute.target.model, "gpt-5.6-luna");
      store.close();
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
          appServer: async () => ({
            complexityAdjustment: -10,
            category: "implementation",
            confidence: 0.9,
            reasonCodes: ["CLASSIFIER_COMPLEXITY_DOWN"],
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
