import { canonicalJson } from "./io.mjs";
import { OPERATION_ACTIONS, OPERATION_REVIEW_SCHEMA } from "./operation-contract.mjs";

// The old host inventory stays frozen. Permit only this reviewed additive
// service extension behind it; old inputs retain their exact interpretation.
export function compatibleToolDefinitions(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  const contract = (definitions) => definitions.map(({ name, inputSchema }) => ({ name, inputSchema }));
  const before = contract(previous);
  const after = contract(next);
  if (canonicalJson(before) === canonicalJson(after)) return true;
  if (after.filter((tool) => tool.name === "manage_stage").length !== 1) return false;
  const previousManage = before.find((tool) => tool.name === "manage_stage")?.inputSchema;
  const projected = structuredClone(previousManage ? after : after.filter((tool) => tool.name !== "manage_stage"));
  const nextManage = projected.find((tool) => tool.name === "manage_stage")?.inputSchema;
  if (previousManage && !previousManage.properties?.operationReview && nextManage?.properties?.operationReview) {
    if (canonicalJson(nextManage.properties.operationReview) !== canonicalJson(OPERATION_REVIEW_SCHEMA)
      || nextManage.required?.includes("operationReview")) return false;
    const priorActions = previousManage.properties?.action?.enum;
    if (canonicalJson(nextManage.properties.action.enum) !== canonicalJson([...(priorActions || []), ...OPERATION_ACTIONS])) return false;
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
