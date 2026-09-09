const text = { type: "string", minLength: 1, maxLength: 10000 };
const identity = { type: "string", minLength: 1, maxLength: 256 };
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const reference = { type: "object", additionalProperties: false, required: ["source", "digest"], properties: {
  source: { type: "string", enum: ["child", "root", "command_journal"] }, digest,
  line: { type: "integer", minimum: 1 }, callId: identity, turnId: identity,
} };
export const OPERATION_ACTIONS = ["read_operations", "reconcile_operations"];
export const OPERATION_REVIEW_SCHEMA = { type: "object", additionalProperties: false,
  required: ["snapshotDigest", "items"], properties: {
    snapshotDigest: digest,
    items: { type: "array", minItems: 1, maxItems: 1000, items: { type: "object", additionalProperties: false,
      required: ["operationId", "conclusion", "original", "evidence", "basis", "resultReview"], properties: {
        operationId: identity, conclusion: { type: "string", enum: ["not_started", "completed", "stopped", "unresolved"] },
        original: reference, evidence: { type: "array", maxItems: 100, items: reference }, basis: text, resultReview: text,
        unresolved: { type: "object", additionalProperties: false, required: ["source", "owner", "nextStep", "resumeCondition"],
          properties: { source: text, owner: text, nextStep: text, resumeCondition: text } },
      } } },
  } };
