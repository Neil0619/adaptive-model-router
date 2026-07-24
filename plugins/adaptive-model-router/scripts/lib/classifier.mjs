import {
  CATEGORIES,
  CLASSIFIER_COOLDOWN_MS,
  CLASSIFIER_FAILURE_LIMIT,
  CLASSIFIER_TIMEOUT_MS,
  PROMPT_SUMMARY_LIMIT,
} from "./constants.mjs";
import { normalizeCatalog, selectAutomaticRoute } from "./catalog.mjs";
import { redactPromptSummary } from "./io.mjs";
import { assertSchema } from "./schema.mjs";
import { withAppServer } from "./app-server.mjs";

export const CLASSIFIER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["complexityAdjustment", "category", "confidence", "reasonCodes"],
  properties: {
    complexityAdjustment: { type: "integer", enum: [-10, 0, 10] },
    category: { type: "string", enum: CATEGORIES },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasonCodes: {
      type: "array",
      maxItems: 1,
      items: { type: "string", enum: ["CLASSIFIER_COMPLEXITY_UP", "CLASSIFIER_COMPLEXITY_DOWN"] },
    },
  },
};

export function buildClassifierPrompt({ goal, phase, signals }) {
  const summary = redactPromptSummary(goal, Math.min(PROMPT_SUMMARY_LIMIT, 1_250));
  const safePhase = redactPromptSummary(phase, 120);
  const booleans = Object.fromEntries(Object.entries(signals || {}).map(([key, value]) => [key, value === true]));
  return [
    "Classify one bounded Codex stage. Return only JSON matching the supplied schema.",
    "Use only the supplied redacted summary, phase, and boolean signals.",
    `Summary: ${summary}`,
    `Phase: ${safePhase || "unspecified"}`,
    `Signals: ${JSON.stringify(booleans)}`,
  ].join("\n").slice(0, PROMPT_SUMMARY_LIMIT);
}

export async function classifyBorderline({
  goal,
  phase,
  signals,
  context,
  store,
  settings,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
  appServer = withAppServer,
  now = Date.now(),
}) {
  if (
    settings.classifierMode !== "auxiliary" ||
    process.env.ADAPTIVE_ROUTER_DISABLE_CLASSIFIER === "1" ||
    process.env.ADAPTIVE_ROUTER_INTERNAL === "1"
  ) {
    return { state: "skipped", result: null, reasonCode: "CLASSIFIER_SKIPPED" };
  }
  if (process.env.ADAPTIVE_ROUTER_LOCAL_ONLY === "1") {
    return { state: "skipped", result: null, reasonCode: "CLASSIFIER_SKIPPED" };
  }
  const health = store.classifierHealth(context);
  if (health.openedUntil > now) {
    return { state: "circuit_open", result: null, reasonCode: "CLASSIFIER_CIRCUIT_OPEN" };
  }
  const prompt = buildClassifierPrompt({ goal, phase, signals });
  try {
    const result = await appServer(
      async (client, deadlineAt) => {
        const classifierCatalog = normalizeCatalog(await client.listModels(deadlineAt));
        const target = selectAutomaticRoute(classifierCatalog, "luna", "low");
        if (!target) throw new Error("classifier model unavailable");
        return client.classify({
          model: target.model,
          effort: target.effort,
          prompt,
          outputSchema: CLASSIFIER_OUTPUT_SCHEMA,
        }, deadlineAt);
      },
      { timeoutMs },
    );
    assertSchema(CLASSIFIER_OUTPUT_SCHEMA, result, "classifier output");
    if (result.complexityAdjustment > 0 && !result.reasonCodes.includes("CLASSIFIER_COMPLEXITY_UP")) {
      throw new Error("classifier reason code does not match adjustment");
    }
    if (result.complexityAdjustment < 0 && !result.reasonCodes.includes("CLASSIFIER_COMPLEXITY_DOWN")) {
      throw new Error("classifier reason code does not match adjustment");
    }
    store.classifierSucceeded(context);
    return { state: "used", result, reasonCode: result.reasonCodes[0] || null };
  } catch {
    store.classifierFailed(context, {
      limit: CLASSIFIER_FAILURE_LIMIT,
      cooldownMs: CLASSIFIER_COOLDOWN_MS,
      now,
    });
    return { state: "fallback", result: null, reasonCode: "CLASSIFIER_FALLBACK" };
  }
}
