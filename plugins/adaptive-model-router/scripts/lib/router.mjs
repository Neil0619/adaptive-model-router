import { randomUUID } from "node:crypto";
import { getModelCatalog, selectAutomaticRoute, selectExplicitRoute } from "./catalog.mjs";
import { classifyBorderline } from "./classifier.mjs";
import { MAX_ESCALATIONS, SCHEMA_VERSION, EFFORT_ORDER, FAMILY_ORDER } from "./constants.mjs";
import { ROUTE_INPUT_SCHEMA, ROUTE_OUTPUT_SCHEMA } from "./contracts.mjs";
import { RouterStore } from "./database.mjs";
import { clamp } from "./io.mjs";
import { normalizeModelSlug } from "./model-slug.mjs";
import { assertSchema } from "./schema.mjs";
import {
  desiredRoute,
  deterministicReasonCodes,
  isTrivialTask,
  scoreTask,
} from "./scorer.mjs";

function uniqueCodes(codes) {
  return [...new Set(codes.filter(Boolean))].slice(0, 8);
}

function stepEffort(effort) {
  const index = EFFORT_ORDER.indexOf(effort);
  if (index < 0) return null;
  return EFFORT_ORDER[Math.min(index + 1, EFFORT_ORDER.length - 1)];
}

function strongerFamily(family) {
  const index = FAMILY_ORDER.indexOf(family);
  if (index < 0 || index === FAMILY_ORDER.length - 1) return family;
  return FAMILY_ORDER[index + 1];
}

function publicRoute(internal) {
  const result = {
    schemaVersion: internal.schemaVersion,
    routeId: internal.routeId,
    action: internal.action,
    category: internal.category,
    reasonCodes: internal.reasonCodes,
    verificationGate: internal.verificationGate,
    classifier: internal.classifier,
    escalation: internal.escalation,
    rootTask: internal.rootTask,
    taskMode: internal.taskMode,
  };
  if (internal.target) result.target = internal.target;
  assertSchema(ROUTE_OUTPUT_SCHEMA, result, "route output");
  if (result.action === "delegate" && !result.target) throw new Error("delegate route requires a target");
  if (result.action !== "delegate" && result.target) throw new Error("non-delegate route cannot include a target");
  return result;
}

function baseRoute({
  action,
  category = "general",
  codes,
  gate = "none",
  classifier = "not_needed",
  escalation = null,
  rootTask = { modelVisibility: "host_managed", reasoningEffortVisibility: "host_only", changedByRouter: false },
  taskMode = "automatic",
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    routeId: randomUUID(),
    action,
    category,
    reasonCodes: uniqueCodes(codes),
    verificationGate: gate,
    classifier: { state: classifier },
    escalation: escalation || { state: "none", count: 0, limit: MAX_ESCALATIONS },
    family: null,
    target: null,
    previousRouteId: null,
    rootTask,
    taskMode,
  };
}

function contextualRoute(store, context, options) {
  return baseRoute({
    ...options,
    rootTask: store.rootTask(context),
    taskMode: store.hostModelState(context).taskMode,
  });
}

function sourceCode(source) {
  return {
    request: "EXPLICIT_OVERRIDE",
    once: "ONCE_OVERRIDE",
    session: "SESSION_OVERRIDE",
    project: "PROJECT_OVERRIDE",
    global: "GLOBAL_OVERRIDE",
  }[source] || null;
}

function failOpen(reasonCode = "STORAGE_UNAVAILABLE") {
  return publicRoute(baseRoute({ action: "continue", codes: [reasonCode] }));
}

function validateRouteInput(input) {
  assertSchema(ROUTE_INPUT_SCHEMA, input, "route_stage input");
  if (input.override && input.override.model == null && input.override.effort == null) {
    throw new Error("override must include model or effort");
  }
  if (input.override?.model != null) {
    const normalized = normalizeModelSlug(input.override.model);
    if (!normalized) {
      const error = new Error("override model has an invalid format");
      error.code = "INVALID_INPUT";
      throw error;
    }
    input.override.model = normalized;
  }
  if (input.evidence.verificationFailed === true) {
    if (!input.previousRouteId) throw new Error("previousRouteId is required after verification failure");
    if (!input.evidence.failureType) throw new Error("failureType is required after verification failure");
  }
}

function escalationPlan(previous, evidence, desired) {
  if (!previous || evidence.verificationFailed !== true) {
    return { desired, status: { state: "none", count: 0, limit: MAX_ESCALATIONS }, minimumEffort: null, previousModel: null };
  }
  const priorCount = Number(previous.escalation_count || 0);
  if (["environment", "information"].includes(evidence.failureType)) {
    return {
      desired: { ...desired, family: previous.family || desired.family, effort: previous.effort || desired.effort },
      status: { state: "held", count: priorCount, limit: MAX_ESCALATIONS },
      minimumEffort: previous.effort,
      previousModel: previous.model,
      reasonCode: "NON_REASONING_FAILURE",
    };
  }
  if (evidence.failureType !== "reasoning") {
    return {
      desired,
      status: { state: "held", count: priorCount, limit: MAX_ESCALATIONS },
      minimumEffort: previous.effort,
      previousModel: null,
      reasonCode: "NON_REASONING_FAILURE",
    };
  }
  if (priorCount >= MAX_ESCALATIONS) {
    return {
      askUser: true,
      desired,
      status: { state: "exhausted", count: MAX_ESCALATIONS, limit: MAX_ESCALATIONS },
      reasonCode: "ESCALATION_LIMIT_REACHED",
    };
  }
  const count = priorCount + 1;
  let family = previous.family || desired.family;
  let effort = stepEffort(previous.effort) || desired.effort;
  let previousModel = previous.model;
  if (count >= 2 || effort === previous.effort) {
    const stronger = strongerFamily(family);
    if (stronger !== family) {
      family = stronger;
      previousModel = null;
    } else if (effort === previous.effort) {
      return {
        askUser: true,
        desired,
        status: { state: "unavailable", count: priorCount, limit: MAX_ESCALATIONS },
        reasonCode: "MONOTONIC_ESCALATION_UNAVAILABLE",
      };
    }
  }
  return {
    desired: { ...desired, family, effort },
    status: { state: "increased", count, limit: MAX_ESCALATIONS },
    minimumEffort: previous.effort,
    previousModel,
    reasonCode: "REASONING_ESCALATION",
  };
}

async function routeWithStore(input, options, store) {
  validateRouteInput(input);
  const context = store.context({ cwd: options.cwd || process.cwd(), contextId: input.contextId });
  const settings = store.getSettings(context);
  const hostState = store.hostModelState(context);
  let previous = null;
  if (input.previousRouteId) {
    previous = store.findRoute(context, input.previousRouteId);
    if (!previous) throw new Error("previousRouteId does not belong to the current project and context");
    if (previous.action !== "delegate") throw new Error("previousRouteId must reference a delegated route");
  }

  if (hostState.taskMode === "pending_confirmation" || hostState.taskMode === "manual_root") {
    const route = contextualRoute(store, context, {
      action: "continue",
      codes: [hostState.taskMode === "pending_confirmation" ? "HOST_MODEL_INTENT_PENDING" : "MANUAL_ROOT_SELECTED"],
    });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }

  const policy = store.ensurePolicy(context);

  const initialOverride = store.resolveOverride(context, input.override || null, settings);
  if (!settings.enabled || initialOverride.override?.mode === "disabled") {
    const route = contextualRoute(store, context, { action: "continue", codes: ["ROUTER_DISABLED"] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  if (input.evidence.hostCanDelegate === false) {
    const route = contextualRoute(store, context, { action: "continue", codes: ["HOST_DELEGATION_UNAVAILABLE"] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  if (!initialOverride.override && isTrivialTask(input.goal, input.evidence)) {
    const code = input.evidence.workProduct === false ? "NO_WORK_PRODUCT" : "TRIVIAL_CONTINUE";
    const route = contextualRoute(store, context, { action: "continue", codes: [code] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }

  const catalogResult = await getModelCatalog({ provided: options.catalog || null, store });
  if (!catalogResult.models.length) {
    const route = contextualRoute(store, context, { action: "continue", codes: ["CATALOG_UNAVAILABLE"] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }

  let scored = scoreTask({ goal: input.goal, phase: input.phase, evidence: input.evidence, policy });
  let classifier = { state: "not_needed", result: null, reasonCode: null };
  const targetFullyLocked = Boolean(initialOverride.override?.model && initialOverride.override?.effort);
  if (scored.borderline && !targetFullyLocked) {
    classifier = await classifyBorderline({
      goal: input.goal,
      phase: input.phase,
      signals: scored.signals,
      catalog: catalogResult.models,
      context,
      store,
      settings,
      timeoutMs: options.classifierTimeoutMs,
      appServer: options.appServer,
      now: options.now,
    });
    if (classifier.result) {
      scored = {
        ...scored,
        score: clamp(scored.score + classifier.result.complexityAdjustment, 0, 100),
        confidence: Math.max(scored.confidence, classifier.result.confidence),
      };
    }
  }
  let desired = desiredRoute(scored, input.evidence);
  const escalation = escalationPlan(previous, input.evidence, desired);
  if (escalation.askUser) {
    const route = contextualRoute(store, context, {
      action: "ask_user",
      category: scored.category,
      codes: [escalation.reasonCode],
      classifier: classifier.state,
      escalation: escalation.status,
    });
    route.previousRouteId = input.previousRouteId || null;
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  desired = escalation.desired;

  for (let claimAttempt = 0; claimAttempt < 2; claimAttempt += 1) {
    const resolved = store.resolveOverride(context, input.override || null, settings);
    const override = resolved.override;
    if (override?.mode === "disabled") {
      const route = contextualRoute(store, context, { action: "continue", category: scored.category, codes: ["ROUTER_DISABLED"] });
      store.commitRoute(context, route, null);
      return publicRoute(route);
    }
    const requestedEffort = override?.effort || desired.effort;
    let selected;
    if (override?.model) {
      selected = selectExplicitRoute(catalogResult.models, override.model, requestedEffort, {
        effortWasExplicit: override.effort != null,
        minimumEffort: escalation.minimumEffort,
      });
    } else if (escalation.previousModel && !override?.model) {
      selected = selectExplicitRoute(catalogResult.models, escalation.previousModel, requestedEffort, {
        effortWasExplicit: false,
        minimumEffort: escalation.minimumEffort,
      });
    } else {
      selected = selectAutomaticRoute(catalogResult.models, desired.family, requestedEffort, {
        minimumEffort: escalation.minimumEffort,
        exactEffort: override?.effort != null,
      });
    }
    if (override?.effort && selected?.effort !== override.effort) selected = null;
    if (!selected || (scored.signals.risk && !override?.model && selected.family !== "sol")) {
      const explicit = Boolean(override?.model || override?.effort);
      const code = explicit ? "EXPLICIT_TARGET_UNAVAILABLE" : escalation.status.state === "increased"
        ? "MONOTONIC_ESCALATION_UNAVAILABLE"
        : "CATALOG_UNAVAILABLE";
      const route = contextualRoute(store, context, {
        action: explicit || escalation.status.state === "increased" ? "ask_user" : "continue",
        category: scored.category,
        codes: [code, sourceCode(resolved.source)],
        classifier: classifier.state,
        escalation: explicit ? escalation.status : { ...escalation.status, state: escalation.status.state === "increased" ? "unavailable" : escalation.status.state },
      });
      route.previousRouteId = input.previousRouteId || null;
      store.commitRoute(context, route, null);
      return publicRoute(route);
    }
    const learned = Number(policy.categoryOffsets?.[scored.category] || 0) !== 0;
    const codes = [
      sourceCode(resolved.source),
      escalation.reasonCode,
      classifier.reasonCode,
      ...deterministicReasonCodes(scored, { learned }),
    ];
    if (selected.familyFallback) codes.push("MODEL_FAMILY_FALLBACK");
    if (selected.effortFallback) codes.push("EFFORT_CAPABILITY_FALLBACK");
    const route = contextualRoute(store, context, {
      action: "delegate",
      category: scored.category,
      codes,
      gate: desired.verificationGate,
      classifier: classifier.state,
      escalation: escalation.status,
    });
    route.target = { model: selected.model, effort: selected.effort };
    route.family = selected.family;
    route.previousRouteId = input.previousRouteId || null;
    const committed = store.commitRoute(context, route, resolved.onceId);
    if (committed.committed) return publicRoute(route);
  }
  return failOpen("STORAGE_UNAVAILABLE");
}

export async function routeStage(input, options = {}) {
  let ownedStore = null;
  try {
    const store = options.store || (ownedStore = new RouterStore(options.database ? { path: options.database } : {}));
    return await routeWithStore(input, options, store);
  } catch (error) {
    if (error?.code === "INVALID_INPUT" || /required|not allowed|does not belong|must reference|override must/i.test(String(error?.message))) throw error;
    return failOpen("STORAGE_UNAVAILABLE");
  } finally {
    ownedStore?.close();
  }
}
