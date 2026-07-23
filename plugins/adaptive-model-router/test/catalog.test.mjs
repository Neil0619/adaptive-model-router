import test from "node:test";
import assert from "node:assert/strict";
import {
  modelFamily,
  normalizeCatalog,
  selectAutomaticRoute,
  selectExplicitRoute,
} from "../scripts/lib/catalog.mjs";

test("catalog filters hidden and unknown models from automatic selection", () => {
  const catalog = normalizeCatalog([
    { slug: "C:/Users/person/private", visibility: "list", priority: -2 },
    { slug: "sk-private-model-secret-123456", visibility: "list", priority: -1 },
    { slug: "gpt-5.6-sol", visibility: "hide", priority: 1, supported_reasoning_levels: ["high"] },
    { model: "gpt-5.6-luna", hidden: true, priority: 1, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { slug: "future-mystery", id: "sk-private-alias-secret-123456", visibility: "list", priority: 0, supported_reasoning_levels: ["high"] },
    { slug: "gpt-5.6-terra", visibility: "list", priority: 2, supported_reasoning_levels: ["medium"] },
  ]);
  assert.equal(modelFamily(catalog[0]), null);
  assert.equal(catalog[0].id, "future-mystery");
  assert.equal(catalog.some((entry) => entry.model.includes("private")), false);
  assert.equal(catalog.find((entry) => entry.model === "gpt-5.6-luna").visibility, "hide");
  assert.deepEqual(selectAutomaticRoute(catalog, "sol", "medium"), {
    model: "gpt-5.6-terra",
    effort: "medium",
    family: "terra",
    familyFallback: true,
    effortFallback: false,
  });
});

test("catalog uses ascending numeric priority", () => {
  const catalog = normalizeCatalog([
    { slug: "gpt-5.6-sol", visibility: "list", priority: 9, supported_reasoning_levels: ["high"] },
    { model: "gpt-5.6-sol", id: "alias", visibility: "list", priority: 1, supportedReasoningEfforts: ["xhigh"] },
  ]);
  assert.equal(catalog[0].priority, 1);
  assert.equal(selectAutomaticRoute(catalog, "sol", "high").effort, "xhigh");
});

test("explicit effort is exact while automatic effort may strengthen", () => {
  const catalog = normalizeCatalog([
    { slug: "gpt-5.6-terra", visibility: "list", supported_reasoning_levels: ["high", "xhigh"] },
  ]);
  assert.equal(selectExplicitRoute(catalog, "gpt-5.6-terra", "medium", { effortWasExplicit: true }), null);
  assert.equal(selectExplicitRoute(catalog, "gpt-5.6-terra", "medium", { effortWasExplicit: false }).effort, "high");
});
