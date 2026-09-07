import { randomUUID } from "node:crypto";
import { getModelCatalog, selectDelegateCatalog } from "./catalog.mjs";
import { classifyBorderline } from "./classifier.mjs";
import { MAX_ESCALATIONS, SCHEMA_VERSION } from "./constants.mjs";
import { ROUTE_INPUT_SCHEMA, ROUTE_OUTPUT_SCHEMA } from "./contracts.mjs";
import { RouterStore } from "./database.mjs";
import { buildContextPackage, createDelegationTicket } from "./delegation-gate.mjs";
import { normalizeHookReadinessFailure } from "./hook-readiness.mjs";
import { newTaskQualification } from "./lifecycle-qualification.mjs";
import { clamp, parseJson } from "./io.mjs";
import { opaqueId } from "./context.mjs";
import { readModelPolicy } from "./model-policy-store.mjs";
import { decideWorkLevel, resolveModelTarget, nextWorkLevel, levelForTarget } from "./model-policy.mjs";
import { normalizeModelSlug } from "./model-slug.mjs";
import { assertSchema } from "./schema.mjs";
import {
  deterministicReasonCodes,
  isTrivialTask,
  scoreTask,
} from "./scorer.mjs";

function uniqueCodes(codes) {
  return [...new Set(codes.filter(Boolean))].slice(0, 8);
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
  if (internal.decision) result.decision = internal.decision;
  if (internal.blockingRouteId) result.blockingRouteId = internal.blockingRouteId;
  if (internal.target) result.target = internal.target;
  if (internal.carrier) result.carrier = internal.carrier;
  assertSchema(ROUTE_OUTPUT_SCHEMA, result, "route output");
  if (result.action === "delegate" && (!result.target || !result.carrier)) {
    throw new Error("delegate route requires a target and carrier");
  }
  if (result.action === "busy" && !result.blockingRouteId) {
    throw new Error("busy route requires a blockingRouteId");
  }
  if (result.action !== "busy" && result.blockingRouteId) {
    throw new Error("only busy routes can include a blockingRouteId");
  }
  if (result.action !== "delegate" && (result.target || result.carrier)) {
    throw new Error("non-delegate route cannot include a target or carrier");
  }
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
    carrier: null,
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

function busyRoute(store, context, activeRouteId, {
  category = "general",
  classifier = "not_needed",
  escalation = { state: "none", count: 0, limit: MAX_ESCALATIONS },
} = {}) {
  const busy = contextualRoute(store, context, {
    action: "busy",
    category,
    codes: ["DELEGATION_BUSY"],
    classifier,
    escalation,
  });
  busy.blockingRouteId = activeRouteId;
  return publicRoute(busy);
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
    input = { ...input, override: { ...input.override, model: normalized } };
  }
  if (input.evidence.verificationFailed === true) {
    if (!input.previousRouteId) throw new Error("previousRouteId is required after verification failure");
    if (!input.evidence.failureType) throw new Error("failureType is required after verification failure");
  }
  const delegation = input.hostCapabilities?.delegation;
  if (delegation) {
    if (input.evidence.hostCanDelegate != null && input.evidence.hostCanDelegate !== delegation.available) {
      const error = new Error("hostCapabilities.delegation.available conflicts with evidence.hostCanDelegate");
      error.code = "INVALID_INPUT";
      throw error;
    }
    if (!delegation.available && delegation.targets.length) {
      const error = new Error("hostCapabilities.delegation.targets must be empty when delegation is unavailable");
      error.code = "INVALID_INPUT";
      throw error;
    }
    const models = new Set();
    for (const target of delegation.targets) {
      const normalized = normalizeModelSlug(target.model);
      if (!normalized || normalized !== target.model) {
        const error = new Error("hostCapabilities delegation target model has an invalid format");
        error.code = "INVALID_INPUT";
        throw error;
      }
      if (models.has(normalized) || new Set(target.efforts).size !== target.efforts.length) {
        const error = new Error("hostCapabilities delegation targets must not duplicate models or efforts");
        error.code = "INVALID_INPUT";
        throw error;
      }
      models.add(normalized);
    }
  }
  return input;
}

async function routeWithStore(input, options, store) {
  input = validateRouteInput(input);
  const inspectionContext = store.context({
    cwd: options.cwd || process.cwd(),
    contextId: input.contextId,
    create: false,
  });
  if (store.inspectionGuardActive(inspectionContext)) {
    const error = new Error(
      "route_stage is unavailable during an explicit read-only router inspection; call only the requested inspection tool",
    );
    error.code = "INVALID_INPUT";
    throw error;
  }
  const context = store.context({ cwd: options.cwd || process.cwd(), contextId: input.contextId });
  const settings = store.getSettings(context);
  const hostState = store.hostModelState(context);
  let previous = null;
  if (input.previousRouteId) {
    previous = store.findRoute(context, input.previousRouteId);
    if (!previous) throw new Error("previousRouteId does not belong to the current project and context");
    const rootLocalRetry = previous.action === "continue" && input.evidence.verificationFailed === true;
    if (previous.action !== "delegate" && !rootLocalRetry) {
      throw new Error("previousRouteId must reference a delegated route or a failed root-local continue route");
    }
  }

  if (hostState.taskMode === "pending_confirmation" || hostState.taskMode === "manual_root") {
    const route = contextualRoute(store, context, {
      action: "continue",
      codes: [hostState.taskMode === "pending_confirmation" ? "HOST_MODEL_INTENT_PENDING" : "MANUAL_ROOT_SELECTED"],
    });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }

  // Legacy scoring remains an immutable diagnostic; its offsets never select a target.
  const scoringProfile = store.ensureScoringProfile(context);
  const modelPolicy = readModelPolicy(store.db);
  const initialOverride = store.resolveOverride(context, input.override || null, settings);
  if (!settings.enabled || initialOverride.override?.mode === "disabled") {
    const route = contextualRoute(store, context, { action: "continue", codes: ["ROUTER_DISABLED"] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  const activeRouteId = store.activeDelegationRouteId(context);
  if (activeRouteId) return busyRoute(store, context, activeRouteId);
  const delegationCapabilities = input.hostCapabilities?.delegation || null;
  const claimsDelegationUnavailable = !delegationCapabilities?.available || delegationCapabilities.invocation !== "direct";
  if (claimsDelegationUnavailable && store.hasProvenDirectDelegation(context)
    && !store.hasAuthoritativeToolingRejection(context, input.previousRouteId)) {
    const error = new Error("hostCapabilities contradict a previously observed direct delegation in this task; only an authoritative tooling rejection may downgrade it");
    error.code = "INVALID_INPUT";
    throw error;
  }
  if (claimsDelegationUnavailable) {
    const explicit = initialOverride.override;
    const rejected = explicit ? resolveModelTarget({ policy: modelPolicy, catalog: [], override: explicit,
      demand: decideWorkLevel(scoreTask({ goal: input.goal, phase: input.phase, evidence: input.evidence }), input.evidence, modelPolicy) }).reason : null;
    const route = contextualRoute(store, context, { action: explicit ? "ask_user" : "continue", codes: [rejected || "HOST_DELEGATION_UNAVAILABLE"] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  let stageKey = opaqueId(store.salt, "stage", `${context.contextKey}\0${input.stageId || input.phase}`);
  if (previous?.stage_key) {
    if (input.stageId && previous.stage_key !== stageKey) {
      const error = new Error("previousRouteId must reference the same stageId");
      error.code = "INVALID_INPUT";
      throw error;
    }
    stageKey = previous.stage_key;
  }
  let evidence = input.evidence;
  const prior = store.db.prepare(`SELECT r.*, o.status AS final_status, o.failure_type AS final_failure
    FROM routes r LEFT JOIN outcomes o ON o.route_id=r.route_id
    WHERE r.project_id=? AND r.context_key=? AND r.stage_key=? AND r.action='delegate'
    ORDER BY r.rowid DESC LIMIT 1`).get(context.projectId, context.contextKey, stageKey);
  if (previous && prior && previous.route_id !== prior.route_id
    && (previous.action === "delegate" || prior.final_status !== "passed")) {
    const error = new Error("previousRouteId must reference the latest delegated attempt of this stage");
    error.code = "INVALID_INPUT";
    throw error;
  }
  if (!previous) {
    if (prior && prior.final_status !== "passed") {
      previous = prior;
      if (prior.final_status === "failed") evidence = { ...evidence, verificationFailed: true, failureType: prior.final_failure };
    }
  }
  if (!initialOverride.override && !previous && isTrivialTask(input.goal, evidence)) {
    const route = contextualRoute(store, context, { action: "continue", codes: [evidence.workProduct === false ? "NO_WORK_PRODUCT" : "TRIVIAL_CONTINUE"] });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  let scored = scoreTask({ goal: input.goal, phase: input.phase, evidence, policy: {},
    profile: { ...scoringProfile.definition, profileVersion: scoringProfile.profileVersion } });
  let desired = decideWorkLevel(scored, evidence, modelPolicy);
  let classifier = { state: "not_needed", result: null, reasonCode: null };
  let classifierAdjustment = 0;
  if (scored.borderline && !initialOverride.override && settings.classifierMode === "auxiliary") {
    classifier = await classifyBorderline({ goal: input.goal, phase: input.phase, signals: scored.signals,
      context, store, settings, modelPolicy, timeoutMs: options.classifierTimeoutMs,
      appServer: options.appServer, now: options.now });
    classifierAdjustment = classifier.result?.complexityAdjustment || 0;
    scored = { ...scored, score: clamp(scored.score + classifierAdjustment, 0, 100) };
  }
  if (!initialOverride.override && !previous && desired.rule === "EXACT_MECHANICAL"
    && Number(evidence.batchSize || 0) <= 1) {
    const route = contextualRoute(store, context, { action: "continue", category: scored.category,
      codes: ["LOW_COMPLEXITY_CONTINUE"], classifier: classifier.state });
    store.commitRoute(context, route, null);
    return publicRoute(route);
  }
  const catalogResult = await getModelCatalog({ provided: options.catalog || null, store });
  const delegateCatalog = selectDelegateCatalog(catalogResult.models, delegationCapabilities);
  const escalation = { state: "none", count: 0, limit: modelPolicy.definition.escalation.limit };
  let previousTarget = null;
  let heldTarget = null;
  let escalationCode = null;
  let failureCode = null;
  if (previous?.action === "delegate") {
    const priorDecision = parseJson(previous.decision_json, {});
    previousTarget = { model: previous.model, effort: previous.effort };
    const priorLevel = priorDecision.workLevel || levelForTarget(modelPolicy, previousTarget);
    escalation.count = Number(previous.escalation_count || 0);
    if (priorDecision.policyDigest !== modelPolicy.digest) failureCode = "MODEL_STAGE_POLICY_CHANGED";
    else if (evidence.verificationFailed === true) {
      const outcome = store.db.prepare("SELECT status,failure_type FROM outcomes WHERE route_id=?").get(previous.route_id);
      if (outcome?.status !== "failed" || outcome.failure_type !== evidence.failureType) {
        const error = new Error("verificationFailed requires the matching recorded failed outcome");
        error.code = "INVALID_INPUT";
        throw error;
      }
      if (initialOverride.source === "request") {
        // A current explicit user choice is not an automatic enhancement and
        // cannot replenish (or consume) the stage's automatic budget.
        escalation.state = "held";
        previousTarget = null;
      } else if (evidence.failureType === "reasoning") {
        const next = levelForTarget(modelPolicy, previousTarget) ? nextWorkLevel(modelPolicy, priorLevel) : null;
        if (escalation.count >= escalation.limit) failureCode = "ESCALATION_LIMIT_REACHED";
        else if (!next) failureCode = "MONOTONIC_ESCALATION_UNAVAILABLE";
        else {
          desired = { ...desired, workLevel: next, rule: "REASONING_ESCALATION" };
          escalation.state = "increased";
          escalation.count += 1;
          escalationCode = "REASONING_ESCALATION";
        }
      } else {
        escalation.state = "held";
        heldTarget = previousTarget;
        desired = { ...desired, workLevel: priorLevel, rule: "NON_REASONING_FAILURE" };
        escalationCode = "NON_REASONING_FAILURE";
      }
    } else {
      const outcome = store.db.prepare("SELECT status FROM outcomes WHERE route_id=?").get(previous.route_id);
      if (outcome?.status !== "passed") {
        if (initialOverride.source === "request") previousTarget = null;
        else {
          heldTarget = previousTarget;
          desired = { ...desired, workLevel: priorLevel, rule: "MODEL_STAGE_HELD" };
        }
        escalation.state = "held";
      } else {
        previousTarget = null;
        escalation.count = 0;
      }
    }
  } else if (previous) escalationCode = "ROOT_LOCAL_RETRY";
  const decision = (workLevel, rule) => ({ policyId: modelPolicy.definition.id, policyDigest: modelPolicy.digest,
    policyVersion: modelPolicy.definition.schemaVersion, workLevel, rule });
  const finish = (action, code, rule = desired.rule) => {
    const route = contextualRoute(store, context, { action, category: scored.category,
      codes: [code], classifier: classifier.state, escalation });
    route.previousRouteId = previous?.route_id || null;
    route.stageKey = stageKey;
    route.decision = decision(desired.workLevel, rule);
    store.commitRoute(context, route, null);
    return publicRoute(route);
  };
  if (failureCode) {
    escalation.state = failureCode === "ESCALATION_LIMIT_REACHED" ? "exhausted" : "unavailable";
    return finish("ask_user", failureCode);
  }
  if (desired.workLevel === "ultra" && evidence.parallelWriteRisk === true) return finish("ask_user", "ULTRA_PARALLEL_WRITE_RISK");
  for (let claimAttempt = 0; claimAttempt < 2; claimAttempt += 1) {
    const resolved = store.resolveOverride(context, input.override || null, settings);
    if (resolved.override?.mode === "disabled") return finish("continue", "ROUTER_DISABLED");
    const override = resolved.override || heldTarget;
    if (override?.effort === "ultra" && evidence.parallelWriteRisk === true) return finish("ask_user", "ULTRA_PARALLEL_WRITE_RISK");
    const selection = resolveModelTarget({ policy: modelPolicy, catalog: delegateCatalog, demand: desired,
      override, previous: previousTarget, escalation: escalation.state === "increased" });
    if (!selection.target) {
      if (escalation.state === "increased") {
        escalation.state = "unavailable";
        escalation.count = Number(previous.escalation_count || 0);
      }
      return finish(resolved.override || previousTarget ? "ask_user" : "continue", selection.reason);
    }
    const route = contextualRoute(store, context, {
      action: "delegate", category: scored.category,
      codes: [sourceCode(resolved.source), escalationCode, desired.rule, selection.reason,
        ...deterministicReasonCodes(scored).filter((code) => code !== "MAX_EFFORT_GATE")].filter(Boolean),
      gate: desired.verificationGate, classifier: classifier.state, escalation,
    });
    route.target = selection.target;
    route.family = "configured";
    route.previousRouteId = previous?.route_id || null;
    route.stageKey = stageKey;
    route.decision = decision(selection.workLevel, desired.rule);
    route.scoringSnapshot = {
      profileId: scoringProfile.profileId, baseScore: scored.baseScore, finalScore: scored.score,
      signals: scored.signals, policyOffset: 0, classifierAdjustment, hardSignalCount: scored.hardSignalCount,
      desiredFamily: "configured", desiredEffort: route.target.effort,
      eligibleLearning: false, exclusionCodes: ["MODEL_POLICY_OBSERVE_ONLY"],
    };
    let contextPackage = buildContextPackage(input);
    let qualification = null;
    if (!contextPackage.accepted) {
      const fallback = contextualRoute(store, context, {
        action: "continue",
        category: scored.category,
        codes: [contextPackage.reasonCode],
        classifier: classifier.state,
        escalation,
      });
      store.commitRoute(context, fallback, null);
      return publicRoute(fallback);
    }
    const activeRouteIdAfterScoring = store.activeDelegationRouteId(context);
    if (activeRouteIdAfterScoring) {
      return busyRoute(store, context, activeRouteIdAfterScoring, {
        category: scored.category,
        classifier: classifier.state,
        escalation,
      });
    }
    if (typeof options.lifecycleHookProbe === "function") {
      let readiness;
      try {
        readiness = await options.lifecycleHookProbe({
          cwd: options.cwd || process.cwd(),
          pluginRoot: options.pluginRoot,
          store, context, contextId: input.contextId,
        });
      } catch {
        readiness = null;
      }
      if (readiness?.ready !== true && readiness?.qualificationBinding) {
        const target = resolveModelTarget({ policy: modelPolicy, catalog: delegateCatalog, purpose: "qualification" }).target;
        qualification = target ? newTaskQualification(readiness.qualificationBinding, route.routeId,
          readiness.requalification, readiness.passedRefresh) : null;
        if (qualification) {
          qualification.modelPolicy = { digest: modelPolicy.digest, target };
          route.target = { model: target.model, effort: target.effort };
          route.family = "configured";
          route.decision = decision(modelPolicy.definition.purposes.qualification, "HOST_LIFECYCLE_QUALIFICATION");
          route.category = "general";
          route.reasonCodes = ["HOST_LIFECYCLE_QUALIFICATION"];
          route.verificationGate = "structured-check";
          route.classifier = { state: "not_needed" };
          route.escalation = { state: "none", count: 0, limit: MAX_ESCALATIONS };
          route.previousRouteId = null;
          route.stageKey = opaqueId(store.salt, "stage", `${context.contextKey}\0native-lifecycle-qualification`);
          route.scoringSnapshot.eligibleLearning = false;
          route.scoringSnapshot.exclusionCodes.push("NATIVE_LIFECYCLE_QUALIFICATION");
          contextPackage = buildContextPackage({
            goal: `Return exactly ${qualification.marker}. Do not call tools, read or write files, browse, change Router controls or spawn another child. This is only a fixed native lifecycle self-test, not the original task.`,
            phase: "native-lifecycle-qualification", evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
          });
        }
      }
      if (readiness?.ready !== true && !qualification) {
        const fallback = contextualRoute(store, context, {
          action: "continue",
          category: scored.category,
          codes: [normalizeHookReadinessFailure(readiness)],
          classifier: classifier.state,
          escalation,
        });
        store.commitRoute(context, fallback, null);
        return publicRoute(fallback);
      }
    }
    const ticket = createDelegationTicket();
    if (qualification) ticket.carrier.instruction = `Qualification only: no-tool child, then verify and record one outcome. Server audits its full native transcript. Route the original stage only after success; never retry this self-test. ${ticket.carrier.instruction}`;
    const committed = store.commitRoute(context, route, qualification ? null : resolved.onceId, {
      ticket,
      contextPackage,
      qualification,
      cwd: options.cwd || process.cwd(),
      disk: {
        probe: options.diskProbe || null,
        minimumFreeBytes: options.minimumFreeDiskBytes,
      },
      childBudget: { maximumBytes: options.routerChildByteLimit },
    });
    if (committed.committed) {
      route.carrier = committed.carrier;
      return publicRoute(route);
    }
    if (committed.busy) {
      return busyRoute(store, context, committed.activeRouteId, {
        category: scored.category,
        classifier: classifier.state,
        escalation,
      });
    }
    if (committed.fallback) {
      const fallback = contextualRoute(store, context, {
        action: "continue",
        category: scored.category,
        codes: [committed.fallback],
        classifier: classifier.state,
        escalation,
      });
      store.commitRoute(context, fallback, null);
      return publicRoute(fallback);
    }
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
