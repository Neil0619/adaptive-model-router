export const ROUTER_VERSION = "0.3.1";
export const SCHEMA_VERSION = "3.0";
export const DATABASE_VERSION = 2;
export const MIN_NODE = [24, 15, 0];
export const MAX_ESCALATIONS = 2;
export const CLASSIFIER_TIMEOUT_MS = 8_000;
export const CLASSIFIER_FAILURE_LIMIT = 3;
export const CLASSIFIER_COOLDOWN_MS = 10 * 60 * 1_000;
export const PROMPT_SUMMARY_LIMIT = 2_000;

export const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export const FAMILY_ORDER = ["luna", "terra", "sol"];

export const FAMILY_MAP = Object.freeze({
  "gpt-5.6-luna": "luna",
  "gpt-5.6-terra": "terra",
  "gpt-5.6-sol": "sol",
});

export const CATEGORIES = [
  "mechanical",
  "exploration",
  "documentation",
  "implementation",
  "review",
  "general",
];

export const FAILURE_TYPES = ["reasoning", "environment", "information", "tooling"];
export const VERIFICATION_GATES = ["none", "task-specific", "targeted-tests", "structured-check", "full-checks"];

export const REASON_CODES = [
  "TRIVIAL_CONTINUE",
  "NO_WORK_PRODUCT",
  "LOW_COMPLEXITY_CONTINUE",
  "ROUTER_DISABLED",
  "HOST_DELEGATION_UNAVAILABLE",
  "CATALOG_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "EXPLICIT_OVERRIDE",
  "ONCE_OVERRIDE",
  "SESSION_OVERRIDE",
  "PROJECT_OVERRIDE",
  "GLOBAL_OVERRIDE",
  "LEARNED_POLICY",
  "DEFAULT_POLICY",
  "MECHANICAL_BATCH",
  "AMBIGUOUS_REQUIREMENTS",
  "CROSS_CUTTING_CHANGE",
  "HIGH_RISK",
  "SECURITY_SENSITIVE",
  "MIGRATION_RISK",
  "EXPLORATION_STAGE",
  "REVIEW_STAGE",
  "STRONG_VERIFICATION",
  "MAX_EFFORT_GATE",
  "ULTRA_PARALLEL_WRITE_RISK",
  "CLASSIFIER_COMPLEXITY_UP",
  "CLASSIFIER_COMPLEXITY_DOWN",
  "CLASSIFIER_SKIPPED",
  "CLASSIFIER_FALLBACK",
  "CLASSIFIER_CIRCUIT_OPEN",
  "MODEL_FAMILY_FALLBACK",
  "EFFORT_CAPABILITY_FALLBACK",
  "EXPLICIT_TARGET_UNAVAILABLE",
  "REASONING_ESCALATION",
  "NON_REASONING_FAILURE",
  "ESCALATION_LIMIT_REACHED",
  "MONOTONIC_ESCALATION_UNAVAILABLE",
  "TOOLING_TARGET_EXCLUDED",
  "HOST_MODEL_INTENT_PENDING",
  "MANUAL_ROOT_SELECTED",
];

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  autoActivate: false,
  classifierMode: "auxiliary",
  allowGlobalOverride: false,
});

export const TASK_MODES = ["automatic", "pending_confirmation", "manual_root"];
export const HOST_MODEL_INTENT_DECISIONS = ["manual_root", "keep_automatic"];

export const DEFAULT_OFFSETS = Object.freeze(
  Object.fromEntries(CATEGORIES.map((category) => [category, 0])),
);

export const CONTROL_PREFIXES = ["router:", "路由器："];
// Keep the owned block marker stable so upgrades can remove v0.2.0-era patches.
export const AGENTS_MARKER_START = "<!-- adaptive-model-router:start v0.2.0 -->";
export const AGENTS_MARKER_END = "<!-- adaptive-model-router:end -->";
