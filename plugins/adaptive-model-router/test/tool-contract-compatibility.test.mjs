import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../scripts/lib/service.mjs";
import { compatibleToolDefinitions } from "../scripts/lib/tool-contract-compatibility.mjs";
import { MODEL_POLICY_V1_SCHEMA } from "../scripts/lib/model-policy.mjs";

test("retained shells accept exactly the reviewed policy schema extension in both directions", () => {
  const old = structuredClone(TOOL_DEFINITIONS);
  for (const name of ["preview_model_policy", "activate_model_policy"]) {
    old.find(tool => tool.name === name).inputSchema.properties.definition = structuredClone(MODEL_POLICY_V1_SCHEMA);
  }
  assert.equal(compatibleToolDefinitions(old, TOOL_DEFINITIONS), true);
  assert.equal(compatibleToolDefinitions(TOOL_DEFINITIONS, old), true);
  for (const mutate of [
    tool => tool.inputSchema.properties.definition.properties.schemaVersion.enum.push(3),
    tool => tool.inputSchema.properties.definition.properties.criticalRisk.required = [],
    tool => tool.inputSchema.required = [],
    tool => delete tool.inputSchema.properties.confirm,
  ]) {
    const changed = structuredClone(TOOL_DEFINITIONS);
    mutate(changed.find(tool => tool.name === "activate_model_policy"));
    assert.equal(compatibleToolDefinitions(old, changed), false);
    assert.equal(compatibleToolDefinitions(changed, old), false);
  }
});

test("the old MCP inventory accepts only the reviewed additive residency contract", () => {
  const old = structuredClone(TOOL_DEFINITIONS.filter((tool) => tool.name !== "manage_stage"));
  delete old.find((tool) => tool.name === "record_outcome").inputSchema.properties.closureToken;
  assert.equal(compatibleToolDefinitions(old, TOOL_DEFINITIONS), true);
  assert.equal(compatibleToolDefinitions(TOOL_DEFINITIONS, old), false);
  const changed = structuredClone(TOOL_DEFINITIONS);
  changed.find((tool) => tool.name === "record_outcome").inputSchema.required.push("closureToken");
  assert.equal(compatibleToolDefinitions(old, changed), false);
  assert.equal(compatibleToolDefinitions(old, [...TOOL_DEFINITIONS, { name: "unreviewed", inputSchema: {} }]), false);
  const firstMaintenance = structuredClone(TOOL_DEFINITIONS);
  delete firstMaintenance.find((tool) => tool.name === "manage_stage").inputSchema.properties.senderTranscriptPaths;
  assert.equal(compatibleToolDefinitions(firstMaintenance, TOOL_DEFINITIONS), true);
  const beforeOperations = structuredClone(firstMaintenance);
  const manage = beforeOperations.find((tool) => tool.name === "manage_stage").inputSchema;
  delete manage.properties.operationReview;
  manage.properties.action.enum = manage.properties.action.enum.filter((value) => !["read_operations", "reconcile_operations"].includes(value));
  assert.equal(compatibleToolDefinitions(beforeOperations, TOOL_DEFINITIONS), true);
  const invalid = structuredClone(TOOL_DEFINITIONS);
  invalid.find((tool) => tool.name === "manage_stage").inputSchema.properties.operationReview.required = [];
  assert.equal(compatibleToolDefinitions(beforeOperations, invalid), false);
});
