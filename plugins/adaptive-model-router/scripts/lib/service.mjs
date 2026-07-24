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
import { assertSchema } from "./schema.mjs";
import { desiredRoute, scoreTask } from "./scorer.mjs";

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
  {
    name: "route_stage",
    description: "Choose whether to continue locally, ask the user, or delegate one bounded stage to an available model and effort.",
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
    description: "Score one stage against a supplied or active profile without creating a route, outcome, proposal, or learning cursor.",
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

function shadowRoute(store, args, cwd) {
  const context = store.context({ cwd, contextId: args.contextId, create: false });
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
  const preferred = desiredRoute(scored, args.evidence);
  const lowRoot = scored.score <= definition.thresholds.rootMax
    && Number(args.evidence.batchSize || 0) <= 1
    && !scored.signals.implementation
    && !scored.signals.review
    && !scored.signals.risk
    && !scored.signals.security
    && !scored.signals.migration;
  return {
    shadow: true,
    sideEffects: false,
    profileVersion: Number(definition.profileVersion || active.profileVersion),
    category: scored.category,
    baseScore: scored.baseScore,
    finalScore: scored.score,
    policyOffset: scored.policyOffset,
    hardSignalCount: scored.hardSignalCount,
    preferred: lowRoot
      ? { action: "continue" }
      : { action: "delegate", family: preferred.family, effort: preferred.effort },
    verificationGate: preferred.verificationGate,
  };
}

export async function callRouterTool(name, args, { store, cwd = process.cwd(), routeOptions = {} } = {}) {
  const definition = TOOLS.get(name);
  if (!definition) throw new Error(`unknown tool: ${name}`);
  assertSchema(definition.inputSchema, args, `${name} input`);
  if (name === "route_stage") return routeStage(args, { ...routeOptions, store, cwd });
  if (name === "record_outcome") return recordOutcome(args, { store, cwd });
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
