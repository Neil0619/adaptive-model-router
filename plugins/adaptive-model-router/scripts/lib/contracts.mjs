import {
  CATEGORIES,
  EFFORT_ORDER,
  FAILURE_TYPES,
  REASON_CODES,
  TASK_MODES,
  VERIFICATION_GATES,
} from "./constants.mjs";

export const EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    workProduct: { type: "boolean" },
    requirementsSettled: { type: "boolean" },
    strongVerification: { type: "boolean" },
    highRisk: { type: "boolean" },
    securitySensitive: { type: "boolean" },
    migration: { type: "boolean" },
    crossCutting: { type: "boolean" },
    mechanical: { type: "boolean" },
    ambiguous: { type: "boolean" },
    exploration: { type: "boolean" },
    review: { type: "boolean" },
    batchSize: { type: "integer", minimum: 0, maximum: 1000000 },
    hostCanDelegate: { type: "boolean" },
    verificationFailed: { type: "boolean" },
    failureType: { type: ["string", "null"], enum: [...FAILURE_TYPES, null] },
  },
};

export const ROUTE_OVERRIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    model: { type: "string", minLength: 1, maxLength: 128 },
    effort: { type: "string", enum: EFFORT_ORDER },
  },
};

export const ROUTE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "phase", "evidence", "contextId"],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 100000 },
    phase: { type: "string", minLength: 1, maxLength: 128 },
    evidence: EVIDENCE_SCHEMA,
    contextId: { type: "string", minLength: 1, maxLength: 256 },
    previousRouteId: { type: "string", minLength: 1, maxLength: 128 },
    override: ROUTE_OVERRIDE_SCHEMA,
  },
};

const CLASSIFIER_STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: { type: "string", enum: ["not_needed", "used", "skipped", "fallback", "circuit_open"] },
  },
};

const ESCALATION_STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "count", "limit"],
  properties: {
    state: { type: "string", enum: ["none", "increased", "held", "exhausted", "unavailable"] },
    count: { type: "integer", minimum: 0, maximum: 2 },
    limit: { type: "integer", enum: [2] },
  },
};

export const ROOT_TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["modelVisibility", "reasoningEffortVisibility", "changedByRouter"],
  properties: {
    modelVisibility: { type: "string", enum: ["hook_observed", "host_managed"] },
    model: { type: "string", minLength: 1, maxLength: 128 },
    reasoningEffortVisibility: { type: "string", enum: ["host_only"] },
    changedByRouter: { type: "boolean", enum: [false] },
  },
};

export const ROUTE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "routeId", "action", "category", "reasonCodes", "verificationGate", "classifier", "escalation", "rootTask", "taskMode"],
  properties: {
    schemaVersion: { type: "string", enum: ["3.0"] },
    routeId: { type: "string", minLength: 1 },
    action: { type: "string", enum: ["delegate", "continue", "ask_user"] },
    category: { type: "string", enum: CATEGORIES },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["model", "effort"],
      properties: {
        model: { type: "string", minLength: 1 },
        effort: { type: "string", enum: EFFORT_ORDER },
      },
    },
    reasonCodes: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", enum: REASON_CODES } },
    verificationGate: { type: "string", enum: VERIFICATION_GATES },
    classifier: CLASSIFIER_STATUS_SCHEMA,
    escalation: ESCALATION_STATUS_SCHEMA,
    rootTask: ROOT_TASK_SCHEMA,
    taskMode: { type: "string", enum: TASK_MODES },
  },
};

export const OUTCOME_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["routeId", "contextId", "status", "gate", "failureType", "retries", "escalations", "userCorrection"],
  properties: {
    routeId: { type: "string", minLength: 1, maxLength: 128 },
    contextId: { type: "string", minLength: 1, maxLength: 256 },
    status: { type: "string", enum: ["passed", "failed", "unknown"] },
    gate: { type: "string", enum: VERIFICATION_GATES },
    failureType: { type: ["string", "null"], enum: [...FAILURE_TYPES, null] },
    retries: { type: "integer", minimum: 0, maximum: 1000 },
    escalations: { type: "integer", minimum: 0, maximum: 1000 },
    userCorrection: { type: "boolean" },
  },
};
