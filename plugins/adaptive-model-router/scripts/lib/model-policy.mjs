import { readFileSync } from "node:fs";
import { EFFORT_ORDER } from "./constants.mjs";
import { canonicalJson, payloadHash } from "./io.mjs";
import { normalizeModelSlug } from "./model-slug.mjs";
import { assertSchema } from "./schema.mjs";

export const WORK_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const string = { type: "string", minLength: 1, maxLength: 128 };
const level = { type: "string", enum: WORK_LEVELS };
const SIGNALS = ["requirementsSettled", "strongVerification", "declaredMechanical", "exactOutputCheck",
  "risk", "security", "migration", "publicContract", "review", "ambiguity", "crossCutting",
  "architectureTradeoff", "highFailureCost", "irreversible", "implementation", "exploration", "documentation"];
const signalList = { type: "array", minItems: 1, maxItems: SIGNALS.length, items: { type: "string", enum: SIGNALS } };
const target = { type: "object", additionalProperties: false, required: ["model", "effort"],
  properties: { model: string, effort: { type: "string", enum: EFFORT_ORDER } } };
const object = (properties) => ({ type: "object", additionalProperties: false,
  required: Object.keys(properties), properties });
export const MODEL_POLICY_SCHEMA = object({
  schemaVersion: { type: "integer", enum: [1] },
  id: { ...string, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
  allowedModels: { type: "array", minItems: 1, maxItems: 32, items: object({
    model: string, efforts: { type: "array", minItems: 1, maxItems: EFFORT_ORDER.length,
      items: { type: "string", enum: EFFORT_ORDER } },
  }) },
  targets: object(Object.fromEntries(WORK_LEVELS.map((name) => [name, target]))),
  conditions: object({ xhighHardSignals: { type: "integer", minimum: 2, maximum: 5 },
    maxHardSignals: { type: "integer", minimum: 3, maximum: 5 },
    defaultLevel: { type: "string", enum: ["high"] },
    low: object({ requires: signalList, forbids: signalList }),
    medium: object({ requires: signalList, forbids: signalList }),
    xhighCrossCuttingWith: signalList, maxRequiresAny: signalList, riskFloorSignals: signalList }),
  fallbacks: object(Object.fromEntries(WORK_LEVELS.map((name) => [name,
    { type: "array", maxItems: 5, items: level }]))),
  escalation: object({ limit: { type: "integer", enum: [2] },
    next: object(Object.fromEntries(WORK_LEVELS.slice(0, -1).map((name) => [name, level]))) }),
  purposes: object({ classifier: level, qualification: level, smoke: level }),
});

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  throw error;
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function targetAllowed(policy, value) {
  return Boolean(value && policy.definition.allowedModels.some((entry) =>
    entry.model === value.model && entry.efforts.includes(value.effort)));
}

export function compileModelPolicy(input) {
  assertSchema(MODEL_POLICY_SCHEMA, input, "model policy");
  const definition = JSON.parse(canonicalJson(input));
  const models = new Set();
  for (const entry of definition.allowedModels) {
    if (normalizeModelSlug(entry.model) !== entry.model || /(?:^|[-/])latest$/i.test(entry.model)) invalid("model policy requires exact model slugs");
    if (models.has(entry.model) || new Set(entry.efforts).size !== entry.efforts.length) invalid("model policy must not duplicate models or efforts");
    models.add(entry.model);
  }
  const policy = { definition, digest: payloadHash(definition) };
  for (const [index, name] of WORK_LEVELS.entries()) {
    const value = definition.targets[name];
    for (const later of WORK_LEVELS.slice(index + 1)) {
      const other = definition.targets[later];
      if (value.model === other.model && EFFORT_ORDER.indexOf(value.effort) > EFFORT_ORDER.indexOf(other.effort)) invalid("model policy bindings must not decrease effort within one model");
    }
  }
  for (const [name, value] of Object.entries(definition.targets)) {
    if (!targetAllowed(policy, value)) invalid(`model policy target ${name} is outside allowedModels`);
    // Work levels describe a minimum effort within a model; merged levels may strengthen it.
    if (EFFORT_ORDER.indexOf(value.effort) < EFFORT_ORDER.indexOf(name)) invalid(`model policy target ${name} lowers its effort floor`);
    const fallbacks = definition.fallbacks[name];
    if (new Set(fallbacks).size !== fallbacks.length || fallbacks.some((next) => WORK_LEVELS.indexOf(next) <= WORK_LEVELS.indexOf(name))) invalid("model policy fallbacks must move forward without duplicates");
    const next = definition.escalation.next[name];
    if (next && WORK_LEVELS.indexOf(next) <= WORK_LEVELS.indexOf(name)) invalid("model policy escalation must move forward");
  }
  if (definition.conditions.maxHardSignals < definition.conditions.xhighHardSignals) invalid("Max must require at least as many independent signals as xhigh");
  const conditions = definition.conditions;
  const floor = ["risk", "security", "migration", "publicContract", "review", "architectureTradeoff"];
  const blocked = [...floor, "ambiguity", "crossCutting"];
  for (const name of ["medium", "low"]) {
    if (["requirementsSettled", "strongVerification"].some((signal) => !conditions[name].requires.includes(signal))
      || blocked.some((signal) => !conditions[name].forbids.includes(signal))) invalid("model policy cannot weaken verified downgrade guards");
  }
  if (["declaredMechanical", "exactOutputCheck"].some((signal) => !conditions.low.requires.includes(signal))
    || !conditions.low.forbids.includes("implementation")) invalid("Low requires a mechanical exact-output check");
  if (floor.some((signal) => !conditions.riskFloorSignals.includes(signal))) invalid("model policy cannot weaken the risk floor");
  if (conditions.maxRequiresAny.some((signal) => !["highFailureCost", "irreversible"].includes(signal))
    || conditions.xhighCrossCuttingWith.some((signal) => !["ambiguity", "architectureTradeoff"].includes(signal))) invalid("model policy cannot broaden exceptional entry conditions");
  for (const list of [conditions.low.requires, conditions.low.forbids, conditions.medium.requires,
    conditions.medium.forbids, conditions.xhighCrossCuttingWith, conditions.maxRequiresAny, conditions.riskFloorSignals]) {
    if (new Set(list).size !== list.length) invalid("model policy signal lists must not contain duplicates");
  }
  return freeze(policy);
}

export const DEFAULT_MODEL_POLICY = compileModelPolicy(JSON.parse(
  readFileSync(new URL("../../model-policy.json", import.meta.url), "utf8"),
));

export function decideWorkLevel(scored, evidence, policy = DEFAULT_MODEL_POLICY) {
  const s = scored.signals;
  const conditions = policy.definition.conditions;
  const facts = { ...s, requirementsSettled: evidence.requirementsSettled === true,
    strongVerification: evidence.strongVerification === true, declaredMechanical: evidence.mechanical === true,
    exactOutputCheck: evidence.exactOutputCheck === true };
  const matches = (rule) => rule.requires.every((signal) => facts[signal] === true)
    && rule.forbids.every((signal) => !facts[signal]);
  const risk = Boolean(s.risk || s.security || s.migration || s.publicContract);
  const hard = scored.hardSignalCount;
  const maxEligible = hard >= conditions.maxHardSignals && conditions.maxRequiresAny.some((signal) => facts[signal]);
  let workLevel = conditions.defaultLevel;
  let rule = "QUALITY_DEFAULT";
  if (maxEligible) [workLevel, rule] = ["max", "CRITICAL_CONDITIONS"];
  else if ((s.crossCutting && conditions.xhighCrossCuttingWith.some((signal) => facts[signal])) || hard >= conditions.xhighHardSignals) {
    [workLevel, rule] = ["xhigh", "COMPLEX_CONDITIONS"];
  } else if (matches(conditions.medium)) {
    [workLevel, rule] = ["medium", "SETTLED_VERIFIED"];
    if (matches(conditions.low)) {
      [workLevel, rule] = ["low", "EXACT_MECHANICAL"];
    }
  }
  const minimumLevel = conditions.riskFloorSignals.some((signal) => facts[signal]) ? "high" : "low";
  const verificationGate = risk ? "full-checks" : s.implementation ? "targeted-tests"
    : !evidence.workProduct && scored.category === "general" ? "task-specific" : "structured-check";
  return { workLevel, rule, minimumLevel, maxEligible: Boolean(maxEligible), verificationGate };
}

export function nextWorkLevel(policy, previousLevel) {
  let next = policy.definition.escalation.next[previousLevel];
  const previous = policy.definition.targets[previousLevel];
  while (next && canonicalJson(policy.definition.targets[next]) === canonicalJson(previous)) next = policy.definition.escalation.next[next];
  return next || null;
}

function available(catalog, value) {
  return catalog.some((entry) => entry.visibility === "list" && entry.model === value.model
    && entry.supportedReasoningEfforts.includes(value.effort));
}

export function levelForTarget(policy, value) {
  return WORK_LEVELS.find((name) => canonicalJson(policy.definition.targets[name]) === canonicalJson(value)) || null;
}

export function resolveModelTarget({ policy = DEFAULT_MODEL_POLICY, catalog, demand = null,
  purpose = "delegate", override = null, previous = null, escalation = false, excludeModels = [] }) {
  const requestedLevel = purpose === "delegate" ? demand.workLevel : policy.definition.purposes[purpose];
  const minimum = demand?.minimumLevel || "low";
  const denied = (reason) => ({ target: null, reason });
  const satisfiesGate = (value) => {
    if (EFFORT_ORDER.indexOf(value.effort) < EFFORT_ORDER.indexOf(minimum)) return false;
    if (previous && value.model === previous.model && EFFORT_ORDER.indexOf(value.effort)
      < EFFORT_ORDER.indexOf(previous.effort) + (escalation ? 1 : 0)) return false;
    if (value.effort === "ultra" && !override && !(escalation && previous?.effort === "max")) return false;
    if (value.effort === "max" && !override && !(demand?.maxEligible || (escalation && ["xhigh", "max"].includes(previous?.effort)))) return false;
    return true;
  };
  if (override) {
    const model = override.model || policy.definition.targets[requestedLevel].model;
    const defaultTarget = [policy.definition.targets.high, ...Object.values(policy.definition.targets)]
      .find((entry) => entry.model === model);
    const effort = override.effort || defaultTarget?.effort;
    const value = { model, effort };
    if (!targetAllowed(policy, value)) return denied("MODEL_SCOPE_DENIED");
    if (!satisfiesGate(value)) return denied(escalation ? "MONOTONIC_ESCALATION_UNAVAILABLE" : "RISK_TARGET_CONFLICT");
    if (!available(catalog, value)) return denied("EXPLICIT_TARGET_UNAVAILABLE");
    return { target: value, workLevel: levelForTarget(policy, value) || effort, reason: null };
  }
  for (const name of [requestedLevel, ...policy.definition.fallbacks[requestedLevel]]) {
    const value = policy.definition.targets[name];
    if (excludeModels.includes(value.model) || !satisfiesGate(value)) continue;
    if (available(catalog, value)) return { target: value, workLevel: name,
      reason: name === requestedLevel ? null : "EFFORT_CAPABILITY_FALLBACK" };
  }
  return denied(escalation ? "MONOTONIC_ESCALATION_UNAVAILABLE" : "NO_ALLOWED_TARGET");
}
