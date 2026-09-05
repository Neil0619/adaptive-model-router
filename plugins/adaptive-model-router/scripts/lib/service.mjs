import { DEFAULT_SCORING_PROFILE, EFFORT_ORDER } from "./constants.mjs";
import { OUTCOME_INPUT_SCHEMA, ROUTE_INPUT_SCHEMA } from "./contracts.mjs";
import { RouterStore } from "./database.mjs";
import {
  approvePolicyProposal,
  listPolicyProposals,
  recordOutcome,
  rebasePolicyProposal,
  rejectPolicyProposal,
  rollbackPolicy,
} from "./learning.mjs";
import { routeStage } from "./router.mjs";
import { inspectLifecycleHookReadiness } from "./hook-readiness.mjs";
import { prepareQualificationOutcome } from "./lifecycle-qualification.mjs";
import { assertSchema } from "./schema.mjs";
import { isTrivialTask, scoreTask } from "./scorer.mjs";

import { MODEL_POLICY_SCHEMA, decideWorkLevel } from "./model-policy.mjs";
import { readModelPolicy, modelPolicyStatus, previewModelPolicy, activateModelPolicy, rollbackModelPolicy } from "./model-policy-store.mjs";

const CONTEXT = { type: "string", minLength: 1, maxLength: 256 };
const PROPOSAL = { type: "string", minLength: 1, maxLength: 128 };
const SCORING_PROFILE_DEFINITION = {
  type: "object",
  additionalProperties: false,
  required: ["weights", "thresholds"],
  properties: {
    weights: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(DEFAULT_SCORING_PROFILE.weights),
      properties: Object.fromEntries(
        Object.keys(DEFAULT_SCORING_PROFILE.weights).map((key) => [
          key,
          { type: "integer", minimum: -50, maximum: 100 },
        ]),
      ),
    },
    thresholds: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(DEFAULT_SCORING_PROFILE.thresholds),
      properties: Object.fromEntries(
        Object.keys(DEFAULT_SCORING_PROFILE.thresholds).map((key) => [
          key,
          { type: "integer", minimum: 0, maximum: 100 },
        ]),
      ),
    },
  },
};

export const TOOL_DEFINITIONS = [
  { name: "get_model_policy", description: "Read the active global model scope and immutable policy definition without changing state.",
    inputSchema: { type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT } } },
  { name: "preview_model_policy", description: "Validate and compare a candidate global model policy without writes or model calls.",
    inputSchema: { type: "object", additionalProperties: false, required: ["contextId", "definition"], properties: { contextId: CONTEXT, definition: MODEL_POLICY_SCHEMA } } },
  { name: "activate_model_policy", description: "Explicitly activate one reviewed global model policy using the expected current digest; refuse while inference or delegation is active.",
    inputSchema: { type: "object", additionalProperties: false, required: ["contextId", "definition", "expectedDigest", "confirm"], properties: {
      contextId: CONTEXT, definition: MODEL_POLICY_SCHEMA, expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      confirm: { type: "string", enum: ["ACTIVATE_MODEL_POLICY"] } } } },
  { name: "rollback_model_policy", description: "Explicitly restore the immutable parent policy, including its scope, using the expected current digest; refuse while inference or delegation is active.",
    inputSchema: { type: "object", additionalProperties: false, required: ["contextId", "expectedDigest", "confirm"], properties: {
      contextId: CONTEXT, expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, confirm: { type: "string", enum: ["ROLLBACK_MODEL_POLICY"] } } } },
  {
    name: "route_stage",
    description: "Choose whether to continue locally, ask the user, report a busy Router gate, or delegate one bounded stage to an available model and effort.",
    inputSchema: ROUTE_INPUT_SCHEMA,
  },
  {
    name: "record_outcome",
    description: "Record exactly one strict final verification outcome for a delegated route.",
    inputSchema: OUTCOME_INPUT_SCHEMA,
  },
  {
    name: "get_route_status",
    description: "Show the observed-or-host-managed root-task boundary plus automatic activation, task mode, and the latest redacted route for the current project/context.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT },
    },
  },
  {
    name: "get_route_history",
    description: "List a redacted current-project/context timeline of route decisions, delegated model/effort transitions, reasons, timestamps, and outcomes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId"],
      properties: {
        contextId: CONTEXT,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        action: { type: "string", enum: ["all", "delegate", "continue", "ask_user"] },
      },
    },
  },
  {
    name: "set_route_override",
    description: "Lock, clear, enable, or disable routing at an explicit scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId", "mode", "scope"],
      properties: {
        contextId: CONTEXT,
        mode: { type: "string", enum: ["lock", "auto", "disable", "enable"] },
        scope: { type: "string", enum: ["once", "session", "project", "global", "all"] },
        model: { type: "string", minLength: 1, maxLength: 128 },
        effort: { type: "string", enum: EFFORT_ORDER },
      },
    },
  },
  {
    name: "list_policy_proposals",
    description: "List pending approval-gated learning proposals for the current project.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT },
    },
  },
  {
    name: "approve_policy_proposal",
    description: "Approve one current-project policy proposal and create an immutable revision.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId", "proposalId"], properties: { contextId: CONTEXT, proposalId: PROPOSAL },
    },
  },
  {
    name: "reject_policy_proposal",
    description: "Reject one current-project policy proposal and advance its evidence window.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId", "proposalId"], properties: { contextId: CONTEXT, proposalId: PROPOSAL },
    },
  },
  {
    name: "rollback_policy",
    description: "Move the current project policy back to its immutable parent revision.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT },
    },
  },
  {
    name: "rebase_policy_proposal",
    description: "Rebase one pending or stale offset proposal onto the current immutable policy and scoring profile without changing its evidence delta.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId", "proposalId"], properties: { contextId: CONTEXT, proposalId: PROPOSAL },
    },
  },
  {
    name: "get_learning_status",
    description: "Show the current project's redacted scoring profile, policy revision, evidence eligibility, proposals, and learning safety events.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT },
    },
  },
  {
    name: "reanchor_scoring_profile",
    description: "Activate one manually supplied, higher-version immutable offline scoring profile after exact confirmation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId", "profileVersion", "definition", "confirm"],
      properties: {
        contextId: CONTEXT,
        profileVersion: { type: "integer", minimum: 2, maximum: 1000000 },
        definition: SCORING_PROFILE_DEFINITION,
        confirm: { type: "string", enum: ["REANCHOR_SCORING_PROFILE"] },
      },
    },
  },
  {
    name: "shadow_route_stage",
    description: "Score one stage against a supplied or active profile and return protected before/after state counts without creating a route, outcome, proposal, or learning cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "phase", "evidence", "contextId"],
      properties: {
        goal: ROUTE_INPUT_SCHEMA.properties.goal,
        phase: ROUTE_INPUT_SCHEMA.properties.phase,
        evidence: ROUTE_INPUT_SCHEMA.properties.evidence,
        contextId: CONTEXT,
        definition: SCORING_PROFILE_DEFINITION,
      },
    },
  },
  {
    name: "configure_router",
    description: "Configure project or optional global router settings; policy proposals remain manual.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId", "scope"],
      properties: {
        contextId: CONTEXT,
        scope: { type: "string", enum: ["project", "global"] },
        enabled: { type: "boolean" },
        autoActivate: { type: "boolean" },
        classifierMode: { type: "string", enum: ["auxiliary", "local-only", "disabled"] },
        allowGlobalOverride: { type: "boolean" },
      },
    },
  },
  {
    name: "resolve_host_model_intent",
    description: "Resolve one pending observed root-model change as manual-root mode or keep automatic bounded-stage routing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId", "changeId", "decision"],
      properties: {
        contextId: CONTEXT,
        changeId: { type: "string", minLength: 1, maxLength: 128 },
        decision: { type: "string", enum: ["manual_root", "keep_automatic"] },
      },
    },
  },
  {
    name: "diagnose_router",
    description: "Run local redacted health checks and report whether unimported legacy state exists.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT },
    },
  },
  {
    name: "clear_project_data",
    description: "Clear only the current project's router data after an exact confirmation string.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId", "confirm"],
      properties: { contextId: CONTEXT, confirm: { type: "string", enum: ["CLEAR_PROJECT_DATA"] } },
    },
  },
];

const TOOLS = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function contextFor(store, args, cwd) {
  return store.context({ cwd, contextId: args.contextId });
}

function configure(store, args, cwd) {
  const context = contextFor(store, args, cwd);
  const changes = Object.fromEntries(
    ["enabled", "autoActivate", "classifierMode", "allowGlobalOverride"]
      .filter((key) => Object.hasOwn(args, key))
      .map((key) => [key, args[key]]),
  );
  if (!Object.keys(changes).length) throw new Error("configure_router requires at least one setting");
  if (Object.hasOwn(changes, "autoActivate") && args.scope !== "global") {
    throw new Error("autoActivate is a global setting");
  }
  return store.configure(context, changes, args.scope);
}

function setOverride(store, args, cwd) {
  const context = contextFor(store, args, cwd);
  if (args.scope === "global" && !store.getSettings(context).allowGlobalOverride) {
    throw new Error("global overrides are disabled; enable allowGlobalOverride first");
  }
  if (args.mode === "lock") {
    if (args.scope === "all") throw new Error("lock does not support scope all");
    if (!args.model && !args.effort) throw new Error("lock requires model or effort");
    return store.setOverride(context, { scope: args.scope, model: args.model || null, effort: args.effort || null });
  }
  if (args.model || args.effort) throw new Error(`${args.mode} does not accept model or effort`);
  if (args.mode === "disable") {
    if (args.scope === "all") throw new Error("disable does not support scope all");
    return store.setOverride(context, { scope: args.scope, mode: "disabled" });
  }
  if (args.mode === "enable") {
    const cleared = store.clearOverrides(context, args.scope);
    if (["session", "all"].includes(args.scope)) store.setTaskMode(context, "automatic");
    if (args.scope === "project" || args.scope === "all") store.configure(context, { enabled: true }, "project");
    return { enabled: true, ...cleared };
  }
  const cleared = store.clearOverrides(context, args.scope);
  if (["session", "all"].includes(args.scope)) store.setTaskMode(context, "automatic");
  return cleared;
}

function validateScoringDefinition(definition) {
  const thresholds = definition.thresholds;
  const ordered = [
    thresholds.rootMax,
    thresholds.terraLowMax,
    thresholds.terraMediumMax,
    thresholds.solMediumMax,
    thresholds.solHighMax,
    thresholds.solXhighMax,
    thresholds.solMaxMin,
  ];
  if (ordered.some((value, index) => index > 0 && value <= ordered[index - 1])) {
    throw new Error("scoring profile thresholds must be strictly increasing");
  }
  if (thresholds.solMaxHardSignals < 2 || thresholds.solMaxHardSignals > 5) {
    throw new Error("solMaxHardSignals must be from 2 to 5");
  }
}

function shadowStateCounts(store, context) {
  const currentContextCount = (table) => Number(store.db.prepare(`
    SELECT count(*) AS count FROM ${table}
    WHERE project_id = ? AND context_key = ?
  `).get(context.projectId, context.contextKey).count);
  const currentProjectCount = (table) => Number(store.db.prepare(`
    SELECT count(*) AS count FROM ${table} WHERE project_id = ?
  `).get(context.projectId).count);
  return {
    routes: currentContextCount("routes"),
    outcomes: currentContextCount("outcomes"),
    stopObservations: currentContextCount("stop_observations"),
    proposals: currentProjectCount("policy_proposals"),
    learningCursors: currentProjectCount("learning_cursors"),
    policyRevisions: currentProjectCount("policy_revisions"),
    scoringProfiles: currentProjectCount("scoring_profiles"),
    scoreSnapshots: currentContextCount("route_score_snapshots"),
  };
}

function shadowRoute(store, args, cwd) {
  const context = store.context({ cwd, contextId: args.contextId, create: false });
  const before = shadowStateCounts(store, context);
  const policy = store.peekPolicy(context);
  const active = store.peekScoringProfile(context);
  const definition = args.definition || active.definition;
  validateScoringDefinition(definition);
  const scored = scoreTask({
    goal: args.goal,
    phase: args.phase,
    evidence: args.evidence,
    policy,
    profile: definition,
  });
  const modelPolicy = readModelPolicy(store.db);
  const preferred = decideWorkLevel(scored, args.evidence, modelPolicy);
  const lowRoot = isTrivialTask(args.goal, args.evidence)
    || (preferred.rule === "EXACT_MECHANICAL" && Number(args.evidence.batchSize || 0) <= 1);
  const after = shadowStateCounts(store, context);
  return {
    shadow: true,
    sideEffects: Object.keys(before).some((key) => before[key] !== after[key]),
    stateCounts: { before, after },
    profileVersion: Number(definition.profileVersion || active.profileVersion),
    category: scored.category,
    baseScore: scored.baseScore,
    finalScore: scored.score,
    policyOffset: scored.policyOffset,
    hardSignalCount: scored.hardSignalCount,
    preferred: lowRoot
      ? { action: "continue" }
      : { action: "delegate", workLevel: preferred.workLevel, ...modelPolicy.definition.targets[preferred.workLevel] },
    decision: { policyId: modelPolicy.definition.id, policyDigest: modelPolicy.digest, rule: preferred.rule },
    scoresAreDiagnostic: true,
    verificationGate: preferred.verificationGate,
  };
}

export async function callRouterTool(name, args, { store, cwd = process.cwd(), routeOptions = null, qualificationOptions = {} } = {}) {
  const definition = TOOLS.get(name);
  if (!definition) throw new Error(`unknown tool: ${name}`);
  assertSchema(definition.inputSchema, args, `${name} input`);
  if (name === "get_model_policy") return { ...modelPolicyStatus(store.db, store.context({ cwd, contextId: args.contextId, create: false })), definition: readModelPolicy(store.db).definition };
  if (name === "preview_model_policy") return previewModelPolicy(store.db, args.definition);
  if (name === "activate_model_policy") return activateModelPolicy(store, args);
  if (name === "rollback_model_policy") return rollbackModelPolicy(store, args);
  if (name === "route_stage") {
    const requestedRouteOptions = routeOptions || {};
    const enforcedRouteOptions = requestedRouteOptions.enforceLifecycleHooks !== false
      ? {
          ...requestedRouteOptions,
          lifecycleHookProbe: requestedRouteOptions.lifecycleHookProbe || inspectLifecycleHookReadiness,
        }
      : requestedRouteOptions;
    return routeStage(args, { ...enforcedRouteOptions, store, cwd });
  }
  if (name === "record_outcome") {
    const qualificationProof = await prepareQualificationOutcome(args, {
      store, cwd, ...qualificationOptions,
      inspectBinding: qualificationOptions.inspectBinding || (() => inspectLifecycleHookReadiness({
        cwd, pluginRoot: routeOptions?.pluginRoot, store,
        contextId: args.contextId,
        context: store.context({ cwd, contextId: args.contextId }),
      })),
    });
    return recordOutcome(args, { store, cwd, qualificationProof });
  }
  if (name === "get_route_status") return store.status(contextFor(store, args, cwd));
  if (name === "get_route_history") {
    return store.routeHistory(contextFor(store, args, cwd), {
      limit: args.limit ?? 20,
      action: args.action || "all",
    });
  }
  if (name === "set_route_override") return setOverride(store, args, cwd);
  if (name === "list_policy_proposals") return listPolicyProposals(args, { store, cwd });
  if (name === "approve_policy_proposal") return approvePolicyProposal(args, { store, cwd });
  if (name === "reject_policy_proposal") return rejectPolicyProposal(args, { store, cwd });
  if (name === "rollback_policy") return rollbackPolicy(args, { store, cwd });
  if (name === "rebase_policy_proposal") return rebasePolicyProposal(args, { store, cwd });
  if (name === "get_learning_status") return store.learningStatus(contextFor(store, args, cwd));
  if (name === "reanchor_scoring_profile") {
    validateScoringDefinition(args.definition);
    return store.reanchorScoringProfile(contextFor(store, args, cwd), args);
  }
  if (name === "shadow_route_stage") return shadowRoute(store, args, cwd);
  if (name === "configure_router") return configure(store, args, cwd);
  if (name === "resolve_host_model_intent") {
    return store.resolveHostModelIntent(contextFor(store, args, cwd), args);
  }
  if (name === "diagnose_router") return store.diagnose(contextFor(store, args, cwd));
  if (name === "clear_project_data") return store.clearProject(contextFor(store, args, cwd));
  throw new Error(`unknown tool: ${name}`);
}

export function createServiceStore(options = {}) {
  return new RouterStore(options);
}
