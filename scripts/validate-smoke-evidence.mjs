#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "..");
const schemaPath = join(repoRoot, "docs", "release-evidence", "schema-v1.json");
const forbiddenKeys = new Set([
  "prompt", "source", "stdout", "stderr", "log", "logs", "sessionId", "contextId", "error", "errors",
]);
const topLevelKeys = [
  "schemaVersion", "gate", "status", "generatedAt", "candidate", "environment", "checks", "route", "continuity", "diagnostics", "warnings",
];
const nestedKeys = {
  candidate: ["ref", "commitSha", "pluginTreeSha256"],
  environment: ["platform", "surface", "osVersion", "codexVersion", "nodeVersion", "gitVersion"],
  check: ["id", "blocking", "status"],
  route: ["action", "targetFamily", "targetEffort", "verificationGate", "pendingOutcomes", "stopHookUnknown"],
  continuity: [
    "candidateCommitSha",
    "taskIdentityBeforeSha256", "taskIdentityAfterSha256",
    "contextIdentityBeforeSha256", "contextIdentityAfterSha256",
    "rootModelBefore", "rootModelAfter", "runtimeBefore", "runtimeAfter",
    "transportBefore", "transportAfter", "shimStatus", "routeIdSha256",
    "outcomeRouteIdSha256", "outcomeStatus", "delegatedTargetCount",
    "recordedOutcomeCount", "desktopStayedOpen",
  ],
  diagnostics: ["databaseHealth", "classifierState", "privacy"],
};
const requiredCheckIds = [
  "native-preflight",
  "candidate-frozen",
  "candidate-automated-gate",
  "native-install",
  "installed-candidate-integrity",
  "hook-trust-and-global-on",
  "route-subagent-outcome",
  "root-target-boundary",
  "capability-boundary",
  "redacted-observability",
  "learning-and-shadow",
  "host-model-intent",
  "negative-control",
  "native-and-wrapper-lifecycle",
  "same-task-hot-upgrade",
  "cross-project-persistence",
  "final-state-settled",
];

function fail(message) {
  throw new Error(`invalid smoke evidence: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} fields differ from schema v1`);
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is not an allowed value`);
}

function schemaTypeMatches(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

function validateAgainstSchema(value, schema, path = "root") {
  if (schema.anyOf) {
    const accepted = schema.anyOf.some((candidate) => {
      try {
        validateAgainstSchema(value, candidate, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!accepted) fail(`${path} does not match any schema alternative`);
  }
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) fail(`${path} differs from schema const`);
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) fail(`${path} is outside the schema enum`);
  if (schema.type && !schemaTypeMatches(value, schema.type)) fail(`${path} has the wrong schema type`);

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`${path} is shorter than schema minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`${path} exceeds schema maxLength`);
    if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) fail(`${path} does not match the schema pattern`);
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(Date.parse(value)))) {
      fail(`${path} is not an RFC 3339 date-time`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) fail(`${path} is below schema minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`${path} has too many items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail(`${path} items are not unique`);
    if (schema.items) value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) fail(`${path} is missing required field ${required}`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path} contains additional field ${key}`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateAgainstSchema(value[key], childSchema, `${path}.${key}`);
    }
  }
}

function walk(value, key = "root") {
  if (forbiddenKeys.has(key)) fail(`forbidden field ${key}`);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  }
}

function validateSafeText(serialized) {
  if (/(?:^|[\s"'])(?:[A-Za-z]:[\\/]|\\\\)[^\s"']*/u.test(serialized)) fail("absolute Windows or UNC path detected");
  if (/(?:^|[\s"'])\/(?!\/)[^\s"']+/u.test(serialized)) fail("absolute POSIX path detected");
  if (/(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/u.test(serialized)) {
    fail("secret-like value detected");
  }
}

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(.+))?$/u.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || "", match[5] || ""];
}

function compareRuntimeVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  if (a[3] !== b[3]) {
    if (!a[3]) return 1;
    if (!b[3]) return -1;
    return a[3].localeCompare(b[3]);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return -1;
  if (!b[4]) return 1;
  return a[4].localeCompare(b[4]);
}

function validate(evidence, schema, options = {}) {
  validateAgainstSchema(evidence, schema);
  exactKeys(evidence, topLevelKeys, "root");
  if (evidence.schemaVersion !== 1) fail("schemaVersion must be 1");
  enumValue(evidence.gate, ["windows-native", "macos-native"], "gate");
  enumValue(evidence.status, ["PASS", "FAIL"], "status");
  if (Number.isNaN(Date.parse(evidence.generatedAt))) fail("generatedAt must be an ISO timestamp");

  exactKeys(evidence.candidate, nestedKeys.candidate, "candidate");
  if (typeof evidence.candidate.ref !== "string" || evidence.candidate.ref.length < 1 || evidence.candidate.ref.length > 255) fail("candidate.ref is invalid");
  if (!/^[0-9a-f]{40}$/u.test(evidence.candidate.commitSha)) fail("candidate.commitSha is invalid");
  if (!/^[0-9a-f]{64}$/u.test(evidence.candidate.pluginTreeSha256)) fail("candidate.pluginTreeSha256 is invalid");
  if (options.expectedRef && evidence.candidate.ref !== options.expectedRef) fail("candidate.ref does not match --expected-ref");
  if (options.expectedCommit && evidence.candidate.commitSha !== options.expectedCommit) fail("candidate.commitSha does not match --expected-commit");

  exactKeys(evidence.environment, nestedKeys.environment, "environment");
  enumValue(evidence.environment.platform, ["windows", "macos"], "environment.platform");
  enumValue(evidence.environment.surface, ["cli", "desktop"], "environment.surface");
  for (const key of ["osVersion", "codexVersion", "nodeVersion", "gitVersion"]) {
    if (typeof evidence.environment[key] !== "string" || evidence.environment[key].length < 1) fail(`environment.${key} is invalid`);
  }
  if (evidence.environment.osVersion.length > 120 || evidence.environment.codexVersion.length > 80 || evidence.environment.gitVersion.length > 120) {
    fail("environment version field exceeds schema limits");
  }
  if (evidence.environment.nodeVersion !== "unavailable" && !/^v[0-9]+\.[0-9]+\.[0-9]+/u.test(evidence.environment.nodeVersion)) {
    fail("environment.nodeVersion is invalid");
  }

  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) fail("checks must not be empty");
  const ids = new Set();
  for (const check of evidence.checks) {
    exactKeys(check, nestedKeys.check, "check");
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(check.id) || ids.has(check.id)) fail("check id is invalid or duplicated");
    ids.add(check.id);
    if (typeof check.blocking !== "boolean") fail("check.blocking must be boolean");
    enumValue(check.status, ["PASS", "FAIL", "SKIP"], "check.status");
    if (check.blocking !== true) fail("canonical smoke checks must all be blocking");
  }
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...requiredCheckIds].sort())) {
    fail("checks must contain the complete canonical gate set with no extras");
  }

  exactKeys(evidence.route, nestedKeys.route, "route");
  enumValue(evidence.route.action, ["delegate", "continue", "ask_user", "unavailable"], "route.action");
  enumValue(evidence.route.targetFamily, ["sol", "terra", "luna", "astra", "none"], "route.targetFamily");
  enumValue(evidence.route.targetEffort, ["low", "medium", "high", "xhigh", "max", "ultra", "none"], "route.targetEffort");
  enumValue(evidence.route.verificationGate, ["light-checks", "targeted-tests", "structured-check", "full-checks", "unavailable"], "route.verificationGate");
  for (const key of ["pendingOutcomes", "stopHookUnknown"]) {
    if (!Number.isInteger(evidence.route[key]) || evidence.route[key] < 0) fail(`route.${key} must be a non-negative integer`);
  }

  exactKeys(evidence.continuity, nestedKeys.continuity, "continuity");
  if (!/^[0-9a-f]{40}$/u.test(evidence.continuity.candidateCommitSha)) {
    fail("continuity.candidateCommitSha must be a full commit SHA");
  }
  const hashFields = [
    "taskIdentityBeforeSha256", "taskIdentityAfterSha256",
    "contextIdentityBeforeSha256", "contextIdentityAfterSha256",
    "routeIdSha256", "outcomeRouteIdSha256",
  ];
  for (const key of hashFields) {
    if (!/^[0-9a-f]{64}$/u.test(evidence.continuity[key])) {
      fail(`continuity.${key} must be a SHA-256 digest`);
    }
  }
  enumValue(evidence.continuity.transportBefore, ["native", "stdio-bridge", "unavailable"], "continuity.transportBefore");
  enumValue(evidence.continuity.transportAfter, ["native", "stdio-bridge", "unavailable"], "continuity.transportAfter");
  enumValue(evidence.continuity.shimStatus, ["verified", "not-required", "unavailable"], "continuity.shimStatus");
  enumValue(evidence.continuity.outcomeStatus, ["passed", "failed", "unknown", "unavailable"], "continuity.outcomeStatus");
  for (const key of ["delegatedTargetCount", "recordedOutcomeCount"]) {
    if (!Number.isInteger(evidence.continuity[key]) || evidence.continuity[key] < 0) {
      fail(`continuity.${key} must be a non-negative integer`);
    }
  }
  if (typeof evidence.continuity.desktopStayedOpen !== "boolean") {
    fail("continuity.desktopStayedOpen must be boolean");
  }

  exactKeys(evidence.diagnostics, nestedKeys.diagnostics, "diagnostics");
  enumValue(evidence.diagnostics.databaseHealth, ["ok", "degraded", "unavailable"], "diagnostics.databaseHealth");
  enumValue(evidence.diagnostics.classifierState, ["closed", "open", "unavailable"], "diagnostics.classifierState");
  enumValue(evidence.diagnostics.privacy, ["PASS", "FAIL"], "diagnostics.privacy");
  if (!Array.isArray(evidence.warnings) || evidence.warnings.some((warning) => !/^[A-Z][A-Z0-9_]{2,63}$/u.test(warning))) {
    fail("warnings must contain only stable warning codes");
  }
  if (new Set(evidence.warnings).size !== evidence.warnings.length) fail("warnings must be unique");

  const expectedPlatform = evidence.gate === "windows-native" ? "windows" : "macos";
  if (evidence.environment.platform !== expectedPlatform) fail("gate and environment.platform disagree");

  const blockingFailed = evidence.checks.some((check) => check.blocking && check.status !== "PASS");
  const zeroDigest = "0".repeat(64);
  const continuityTransportValid =
    (evidence.continuity.transportBefore === "native" && evidence.continuity.transportAfter === "native") ||
    (evidence.continuity.transportBefore === "stdio-bridge" && evidence.continuity.transportAfter === "stdio-bridge") ||
    (evidence.continuity.transportBefore === "unavailable" && evidence.continuity.transportAfter === "stdio-bridge");
  const continuityValid =
    evidence.environment.surface === "desktop" &&
    evidence.continuity.candidateCommitSha === evidence.candidate.commitSha &&
    evidence.continuity.taskIdentityBeforeSha256 !== zeroDigest &&
    evidence.continuity.taskIdentityBeforeSha256 === evidence.continuity.taskIdentityAfterSha256 &&
    evidence.continuity.contextIdentityBeforeSha256 !== zeroDigest &&
    evidence.continuity.contextIdentityBeforeSha256 === evidence.continuity.contextIdentityAfterSha256 &&
    evidence.continuity.rootModelBefore !== "unavailable" &&
    evidence.continuity.rootModelBefore === evidence.continuity.rootModelAfter &&
    evidence.continuity.runtimeBefore !== "unavailable" &&
    evidence.continuity.runtimeAfter !== "unavailable" &&
    compareRuntimeVersions(evidence.continuity.runtimeAfter, evidence.continuity.runtimeBefore) > 0 &&
    continuityTransportValid &&
    evidence.continuity.shimStatus ===
      (evidence.continuity.transportAfter === "stdio-bridge" ? "verified" : "not-required") &&
    evidence.continuity.routeIdSha256 !== zeroDigest &&
    evidence.continuity.routeIdSha256 === evidence.continuity.outcomeRouteIdSha256 &&
    evidence.continuity.outcomeStatus === "passed" &&
    evidence.continuity.delegatedTargetCount === 1 &&
    evidence.continuity.recordedOutcomeCount === 1 &&
    evidence.continuity.desktopStayedOpen;
  const passInvariant =
    !blockingFailed &&
    evidence.candidate.commitSha !== "0".repeat(40) &&
    evidence.candidate.pluginTreeSha256 !== "0".repeat(64) &&
    ![evidence.environment.osVersion, evidence.environment.codexVersion, evidence.environment.nodeVersion, evidence.environment.gitVersion].includes("unavailable") &&
    evidence.route.action === "delegate" &&
    ["sol", "terra", "astra"].includes(evidence.route.targetFamily) &&
    evidence.route.targetEffort !== "none" &&
    evidence.route.verificationGate !== "unavailable" &&
    evidence.route.pendingOutcomes === 0 &&
    evidence.route.stopHookUnknown === 0 &&
    continuityValid &&
    evidence.diagnostics.databaseHealth === "ok" &&
    evidence.diagnostics.classifierState === "closed" &&
    evidence.diagnostics.privacy === "PASS" &&
    evidence.warnings.length === 0;
  if ((evidence.status === "PASS") !== passInvariant) fail("status disagrees with blocking checks, privacy, or pending outcomes");
  if (options.requirePass && evidence.status !== "PASS") fail("--require-pass rejects non-PASS evidence");
  walk(evidence);
  validateSafeText(JSON.stringify(evidence));
}

function markdown(evidence) {
  const checks = evidence.checks.map((check) => `| ${check.id} | ${check.blocking ? "yes" : "no"} | ${check.status} |`).join("\n");
  return `# ${evidence.gate} smoke evidence\n\n` +
    `Status: **${evidence.status}**\n\n` +
    `Generated: ${evidence.generatedAt}\n\n` +
    `Candidate: \`${evidence.candidate.ref}\` at \`${evidence.candidate.commitSha}\`\n\n` +
    `Plugin tree SHA-256: \`${evidence.candidate.pluginTreeSha256}\`\n\n` +
    `| Check | Blocking | Status |\n|---|---:|---:|\n${checks}\n\n` +
    `Route: ${evidence.route.action}; target ${evidence.route.targetFamily}/${evidence.route.targetEffort}; gate ${evidence.route.verificationGate}.\n\n` +
    `Pending outcomes: ${evidence.route.pendingOutcomes}; Stop-auto-finalized unknown: ${evidence.route.stopHookUnknown}.\n\n` +
    `Same Desktop task/context: ${evidence.continuity.taskIdentityBeforeSha256 === evidence.continuity.taskIdentityAfterSha256 && evidence.continuity.contextIdentityBeforeSha256 === evidence.continuity.contextIdentityAfterSha256 ? "yes" : "no"}; runtime ${evidence.continuity.runtimeBefore} → ${evidence.continuity.runtimeAfter}; transport ${evidence.continuity.transportAfter}.\n\n` +
    `Database: ${evidence.diagnostics.databaseHealth}; classifier: ${evidence.diagnostics.classifierState}; privacy: ${evidence.diagnostics.privacy}.\n`;
}

function parseArgs(values) {
  const parsed = { writeDerivatives: false, requirePass: false, path: null, expectedRef: null, expectedCommit: null };
  for (const value of values) {
    if (value === "--write-derivatives") parsed.writeDerivatives = true;
    else if (value === "--require-pass") parsed.requirePass = true;
    else if (value.startsWith("--expected-ref=")) parsed.expectedRef = value.slice(15);
    else if (value.startsWith("--expected-commit=")) parsed.expectedCommit = value.slice(18);
    else if (!parsed.path) parsed.path = resolve(value);
    else fail(`unknown argument ${value}`);
  }
  if (!parsed.path) fail("usage: validate-smoke-evidence.mjs EVIDENCE.json [--write-derivatives]");
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const bytes = await readFile(args.path);
const evidence = JSON.parse(bytes.toString("utf8"));
validate(evidence, schema, args);
if (args.writeDerivatives) {
  const stem = basename(args.path, ".json");
  const canonicalBytes = Buffer.from(bytes.toString("utf8").replace(/\r\n?/gu, "\n"), "utf8");
  await writeFile(join(dirname(args.path), `${stem}.md`), markdown(evidence), "utf8");
  await writeFile(join(dirname(args.path), `${stem}.json.sha256`), `${createHash("sha256").update(canonicalBytes).digest("hex")}  ${basename(args.path)}\n`, "utf8");
}
process.stdout.write(`Smoke evidence valid: ${evidence.gate} ${evidence.status}.\n`);
