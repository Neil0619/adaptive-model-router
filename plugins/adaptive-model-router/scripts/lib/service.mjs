import { EFFORT_ORDER } from "./constants.mjs";
import { OUTCOME_INPUT_SCHEMA, ROUTE_INPUT_SCHEMA } from "./contracts.mjs";
import { RouterStore } from "./database.mjs";
import {
  approvePolicyProposal,
  listPolicyProposals,
  recordOutcome,
  rejectPolicyProposal,
  rollbackPolicy,
} from "./learning.mjs";
import { routeStage } from "./router.mjs";
import { assertSchema } from "./schema.mjs";

const CONTEXT = { type: "string", minLength: 1, maxLength: 256 };
const PROPOSAL = { type: "string", minLength: 1, maxLength: 128 };

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
    description: "Return redacted routing state for only the current project and context.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["contextId"], properties: { contextId: CONTEXT },
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
        classifierMode: { type: "string", enum: ["auxiliary", "local-only", "disabled"] },
        allowGlobalOverride: { type: "boolean" },
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
    ["enabled", "classifierMode", "allowGlobalOverride"]
      .filter((key) => Object.hasOwn(args, key))
      .map((key) => [key, args[key]]),
  );
  if (!Object.keys(changes).length) throw new Error("configure_router requires at least one setting");
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
    if (args.scope === "project" || args.scope === "all") store.configure(context, { enabled: true }, "project");
    return { enabled: true, ...cleared };
  }
  return store.clearOverrides(context, args.scope);
}

export async function callRouterTool(name, args, { store, cwd = process.cwd(), routeOptions = {} } = {}) {
  const definition = TOOLS.get(name);
  if (!definition) throw new Error(`unknown tool: ${name}`);
  assertSchema(definition.inputSchema, args, `${name} input`);
  if (name === "route_stage") return routeStage(args, { ...routeOptions, store, cwd });
  if (name === "record_outcome") return recordOutcome(args, { store, cwd });
  if (name === "get_route_status") return store.status(contextFor(store, args, cwd));
  if (name === "set_route_override") return setOverride(store, args, cwd);
  if (name === "list_policy_proposals") return listPolicyProposals(args, { store, cwd });
  if (name === "approve_policy_proposal") return approvePolicyProposal(args, { store, cwd });
  if (name === "reject_policy_proposal") return rejectPolicyProposal(args, { store, cwd });
  if (name === "rollback_policy") return rollbackPolicy(args, { store, cwd });
  if (name === "configure_router") return configure(store, args, cwd);
  if (name === "diagnose_router") return store.diagnose(contextFor(store, args, cwd));
  if (name === "clear_project_data") return store.clearProject(contextFor(store, args, cwd));
  throw new Error(`unknown tool: ${name}`);
}

export function createServiceStore(options = {}) {
  return new RouterStore(options);
}
