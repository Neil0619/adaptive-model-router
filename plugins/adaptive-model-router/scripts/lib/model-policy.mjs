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
export const MODEL_POLICY_V1_SCHEMA = object({
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
// Keep v1 definitions byte-for-byte readable. The two v2 fields are required by
// the compiler only for v2; old policies must not acquire new digest material.
export const MODEL_POLICY_SCHEMA = structuredClone(MODEL_POLICY_V1_SCHEMA);
MODEL_POLICY_SCHEMA.properties.schemaVersion.enum = [1, 2];
Object.assign(MODEL_POLICY_SCHEMA.properties, {
  modelOrder: { type: "array", minItems: 1, maxItems: 32, items: string },
  criticalRisk: object({ signals: signalList, minimumLevel: level }),
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

function compareTargets(policy, left, right) {
  const order = policy.definition.modelOrder;
  if (order && left.model !== right.model) return order.indexOf(left.model) - order.indexOf(right.model);
  return EFFORT_ORDER.indexOf(left.effort) - EFFORT_ORDER.indexOf(right.effort);
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
  if (definition.schemaVersion === 1) {
    if (definition.modelOrder || definition.criticalRisk) invalid("v1 model policy cannot contain v2 fields");
  } else {
    const order = definition.modelOrder;
    if (!order || order.length !== models.size || new Set(order).size !== order.length
      || order.some((model) => !models.has(model))) invalid("v2 modelOrder must name each allowed model exactly once");
    const critical = definition.criticalRisk;
    if (!critical || !critical.signals.includes("highFailureCost") || !critical.signals.includes("irreversible")
      || new Set(critical.signals).size !== critical.signals.length
      || WORK_LEVELS.indexOf(critical.minimumLevel) < WORK_LEVELS.indexOf("high")
      || critical.minimumLevel === "ultra") invalid("v2 criticalRisk requires a bounded floor for high failure cost and irreversibility");
    if (definition.targets[critical.minimumLevel].model !== order.at(-1)) invalid("v2 criticalRisk floor must use the highest configured model");
    if (new Set(Object.values(definition.targets).map(canonicalJson)).size !== WORK_LEVELS.length) invalid("v2 targets require distinct upgrade anchors");
    // Every permitted explicit target has an unambiguous upgrade anchor.
    for (const entry of definition.allowedModels) for (const effort of entry.efforts) {
      if (!levelForTarget(policy, { model: entry.model, effort })) invalid("v2 allowed target must have a work-level binding");
    }
  }
  for (const [index, name] of WORK_LEVELS.entries()) {
    const value = definition.targets[name];
    for (const later of WORK_LEVELS.slice(index + 1)) {
      const other = definition.targets[later];
      if (definition.schemaVersion === 2 && compareTargets(policy, value, other) > 0) invalid("v2 bindings must not decrease the configured model and effort order");
      if (value.model === other.model && EFFORT_ORDER.indexOf(value.effort) > EFFORT_ORDER.indexOf(other.effort)) invalid("model policy bindings must not decrease effort within one model");
    }
  }
  for (const [name, value] of Object.entries(definition.targets)) {
    if (!targetAllowed(policy, value)) invalid(`model policy target ${name} is outside allowedModels`);
    // Work levels describe a minimum effort within a model; merged levels may strengthen it.
    if (definition.schemaVersion === 1 && EFFORT_ORDER.indexOf(value.effort) < EFFORT_ORDER.indexOf(name)) invalid(`model policy target ${name} lowers its effort floor`);
    if (definition.schemaVersion === 2 && EFFORT_ORDER.indexOf(value.effort) < EFFORT_ORDER.indexOf(minimumEffortForLevel(name))) invalid(`model policy target ${name} lowers its effort floor`);
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

function minimumEffortForLevel(name) {
  return ["low", "medium"].includes(name) ? name : "high";
}

export const DEFAULT_MODEL_POLICY = compileModelPolicy(JSON.parse(
  readFileSync(new URL("../../model-policy.json", import.meta.url), "utf8"),
));
export const ECONOMY_MODEL_POLICY = compileModelPolicy(JSON.parse(
  readFileSync(new URL("../../model-policy.economy.json", import.meta.url), "utf8"),
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
  let minimumLevel = conditions.riskFloorSignals.some((signal) => facts[signal]) ? "high" : "low";
  const critical = policy.definition.criticalRisk;
  if (critical?.signals.some((signal) => facts[signal])) {
    minimumLevel = critical.minimumLevel;
    if (WORK_LEVELS.indexOf(workLevel) < WORK_LEVELS.indexOf(minimumLevel)) {
      [workLevel, rule] = [minimumLevel, "CRITICAL_RISK_FLOOR"];
    }
  }
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
    if (policy.definition.schemaVersion === 2) {
      if (compareTargets(policy, value, policy.definition.targets[minimum]) < 0) return false;
      if (previous && compareTargets(policy, value, previous) < (escalation ? 1 : 0)) return false;
      // The top WORK level is exceptional even when its actual effort is max.
      const top = canonicalJson(value) === canonicalJson(policy.definition.targets.ultra);
      if (top && !override && !(escalation && levelForTarget(policy, previous) === "max")) return false;
      return true;
    }
    if (EFFORT_ORDER.indexOf(value.effort) < EFFORT_ORDER.indexOf(minimum)) return false;
    if (previous && value.model === previous.model && EFFORT_ORDER.indexOf(value.effort)
      < EFFORT_ORDER.indexOf(previous.effort) + (escalation ? 1 : 0)) return false;
    if (value.effort === "ultra" && !override && !(escalation && previous?.effort === "max")) return false;
    if (value.effort === "max" && !override && !(demand?.maxEligible || (escalation && ["xhigh", "max"].includes(previous?.effort)))) return false;
    return true;
  };
  if (override) {
    if (policy.definition.schemaVersion === 2 && !override.model && override.effort) {
      const matches = WORK_LEVELS.map((name) => policy.definition.targets[name])
        .filter((value) => value.effort === override.effort);
      if (!matches.length) return denied("MODEL_SCOPE_DENIED");
      const eligible = matches.filter(satisfiesGate);
      if (!eligible.length) return denied(escalation ? "MONOTONIC_ESCALATION_UNAVAILABLE" : "RISK_TARGET_CONFLICT");
      const preferred = policy.definition.targets[requestedLevel];
      const value = [preferred, ...eligible].find((entry) => eligible.includes(entry) && available(catalog, entry));
      if (!value) return denied("EXPLICIT_TARGET_UNAVAILABLE");
      return { target: value, workLevel: levelForTarget(policy, value), reason: null };
    }
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
      reason: name === requestedLevel ? null : policy.definition.schemaVersion === 2 ? "MODEL_CAPABILITY_FALLBACK" : "EFFORT_CAPABILITY_FALLBACK" };
  }
  return denied(escalation ? "MONOTONIC_ESCALATION_UNAVAILABLE" : "NO_ALLOWED_TARGET");
}
