import { canonicalJson } from "./io.mjs";
import { VERIFICATION_EVIDENCE_SCHEMA } from "./audit-records.mjs";
import { OPERATION_ACTIONS, OPERATION_REVIEW_SCHEMA } from "./operation-contract.mjs";
import { CHECKPOINT_ACTIONS, CHECKPOINT_FIELDS } from "./message-checkpoint.mjs";
import { MODEL_POLICY_SCHEMA, MODEL_POLICY_V1_SCHEMA } from "./model-policy.mjs";

// The old host inventory stays frozen. Permit only this reviewed additive
// service extension behind it; old inputs retain their exact interpretation.
export function compatibleToolDefinitions(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  const contract = (definitions) => definitions.map(({ name, inputSchema }) => {
    const schema = structuredClone(inputSchema);
    // Retained shells expose the exact v1 input view; their validation still
    // rejects v2. Only this reviewed extension is projected, never arbitrary
    // additions to a tool or changes to the activation confirmation/CAS fields.
    if (["preview_model_policy", "activate_model_policy"].includes(name)
      && canonicalJson(schema.properties?.definition) === canonicalJson(MODEL_POLICY_SCHEMA)) {
      schema.properties.definition = structuredClone(MODEL_POLICY_V1_SCHEMA);
    }
    return { name, inputSchema: schema };
  });
  const before = contract(previous);
  const after = contract(next);
  const oldEvidence = before.find((tool) => tool.name === "record_outcome")?.inputSchema?.properties?.verificationEvidence;
  const newOutcome = after.find((tool) => tool.name === "record_outcome")?.inputSchema;
  if (oldEvidence && !newOutcome?.properties?.verificationEvidence) return compatibleToolDefinitions(next, previous);
  if (!oldEvidence && newOutcome?.properties?.verificationEvidence) {
    if (canonicalJson(newOutcome.properties.verificationEvidence) !== canonicalJson(VERIFICATION_EVIDENCE_SCHEMA)
      || newOutcome.required?.includes("verificationEvidence")) return false;
    const projected = structuredClone(next);
    delete projected.find((tool) => tool.name === "record_outcome").inputSchema.properties.verificationEvidence;
    return compatibleToolDefinitions(previous, projected);
  }
  if (canonicalJson(before) === canonicalJson(after)) return true;
  if (after.filter((tool) => tool.name === "manage_stage").length !== 1) return false;
  const previousManage = before.find((tool) => tool.name === "manage_stage")?.inputSchema;
  const projected = structuredClone(previousManage ? after : after.filter((tool) => tool.name !== "manage_stage"));
  const nextManage = projected.find((tool) => tool.name === "manage_stage")?.inputSchema;
  // The new cold shell must also load retained A for an unadopted task. Only
  // this exact reviewed additive extension is symmetric; A still validates
  // and rejects actions it cannot implement.
  if (previousManage?.properties?.checkpointId && nextManage && !nextManage.properties?.checkpointId)
    return compatibleToolDefinitions(next, previous);
  if (previousManage && !previousManage.properties?.checkpointId && nextManage?.properties?.checkpointId) {
    for (const [field, definition] of Object.entries(CHECKPOINT_FIELDS)) {
      if (canonicalJson(nextManage.properties[field]) !== canonicalJson(definition) || nextManage.required?.includes(field)) return false;
      delete nextManage.properties[field];
    }
    const actions = nextManage.properties.action.enum;
    if (canonicalJson(actions.slice(-CHECKPOINT_ACTIONS.length)) !== canonicalJson(CHECKPOINT_ACTIONS)) return false;
    nextManage.properties.action.enum = actions.slice(0, -CHECKPOINT_ACTIONS.length);
  }
  if (previousManage && !previousManage.properties?.operationReview && nextManage?.properties?.operationReview) {
    if (canonicalJson(nextManage.properties.operationReview) !== canonicalJson(OPERATION_REVIEW_SCHEMA)
      || nextManage.required?.includes("operationReview")) return false;
    const priorActions = previousManage.properties?.action?.enum;
    const actions = nextManage.properties.action.enum;
    if (OPERATION_ACTIONS.some((action) => actions.filter((value) => value === action).length !== 1)
      || canonicalJson(actions.filter((value) => !OPERATION_ACTIONS.includes(value))) !== canonicalJson(priorActions || [])) return false;
    nextManage.properties.action.enum = priorActions;
    delete nextManage.properties.operationReview;
  }
  if (previousManage && !previousManage.properties?.senderTranscriptPaths && nextManage?.properties?.senderTranscriptPaths) {
    if (canonicalJson(nextManage.properties.senderTranscriptPaths) !== canonicalJson({ type: "array", maxItems: 3,
      uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 } })
      || nextManage.required?.includes("senderTranscriptPaths")) return false;
    delete nextManage.properties.senderTranscriptPaths;
  }
  const outcome = projected.find((tool) => tool.name === "record_outcome")?.inputSchema;
  if (outcome?.properties?.closureToken) {
    if (canonicalJson(outcome.properties.closureToken) !== canonicalJson({ type: "string", pattern: "^[a-f0-9]{64}$" })
      || outcome.required?.includes("closureToken")) return false;
    // P1 installations may already expose the optional token.
    if (!before.find((tool) => tool.name === "record_outcome")?.inputSchema?.properties?.closureToken) delete outcome.properties.closureToken;
  }
  return canonicalJson(before) === canonicalJson(projected);
}
