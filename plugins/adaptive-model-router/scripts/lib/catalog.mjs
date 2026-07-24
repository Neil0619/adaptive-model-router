import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EFFORT_ORDER, FAMILY_MAP, FAMILY_ORDER } from "./constants.mjs";
import { normalizeModelSlug } from "./model-slug.mjs";

const CONSERVATIVE_DELEGATE_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);

function effortValue(effort) {
  const index = EFFORT_ORDER.indexOf(effort);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

export function modelFamily(entry) {
  return FAMILY_MAP[entry.model] || null;
}

export function normalizeCatalog(models = []) {
  return models
    .map((entry) => {
      const model = normalizeModelSlug(entry.model || entry.slug || entry.id);
      if (!model) return null;
      const id = normalizeModelSlug(entry.id) || model;
      const supported = (entry.supportedReasoningEfforts || entry.supported_reasoning_levels || [])
        .map((value) => value?.reasoningEffort || value?.effort || value?.reasoning_effort || value)
        .filter((value) => EFFORT_ORDER.includes(value));
      const defaultEffort = entry.defaultReasoningEffort || entry.default_reasoning_level || supported[0] || "medium";
      return {
        model,
        id,
        visibility: entry.visibility || (entry.hidden === true ? "hide" : "list"),
        priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : Number.MAX_SAFE_INTEGER,
        defaultReasoningEffort: EFFORT_ORDER.includes(defaultEffort) ? defaultEffort : "medium",
        supportedReasoningEfforts: [...new Set(supported.length ? supported : ["low", "medium", "high"])]
          .sort((left, right) => effortValue(left) - effortValue(right)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || left.model.localeCompare(right.model));
}

function automaticEntries(catalog, family) {
  return catalog.filter((entry) => entry.visibility === "list" && modelFamily(entry) === family);
}

function compatibleEffort(entry, requested, minimumEffort = null) {
  const requestedIndex = effortValue(requested);
  const minimumIndex = minimumEffort == null ? -1 : effortValue(minimumEffort);
  const supported = entry.supportedReasoningEfforts.filter((effort) => effortValue(effort) >= minimumIndex);
  if (!supported.length) return null;
  return supported.find((effort) => effortValue(effort) >= requestedIndex) || supported.at(-1) || null;
}

export function selectAutomaticRoute(catalog, requestedFamily, requestedEffort, {
  minimumEffort = null,
  exactEffort = false,
  excludeModels = [],
} = {}) {
  if (exactEffort && minimumEffort != null && effortValue(requestedEffort) < effortValue(minimumEffort)) return null;
  const excluded = new Set(excludeModels);
  const start = FAMILY_ORDER.indexOf(requestedFamily);
  const families = start < 0 ? [] : [
    ...FAMILY_ORDER.slice(start),
    ...FAMILY_ORDER.slice(0, start).reverse(),
  ];
  for (const family of families) {
    for (const entry of automaticEntries(catalog, family)) {
      if (excluded.has(entry.model) || excluded.has(entry.id)) continue;
      if (exactEffort && !entry.supportedReasoningEfforts.includes(requestedEffort)) continue;
      const effort = exactEffort ? requestedEffort : compatibleEffort(entry, requestedEffort, minimumEffort);
      if (!effort) continue;
      return {
        model: entry.model,
        effort,
        family,
        familyFallback: family !== requestedFamily,
        effortFallback: effort !== requestedEffort,
      };
    }
  }
  return null;
}

export function selectDelegateCatalog(rootCatalog, capabilities = null) {
  if (capabilities) {
    const rootEntries = new Map(
      rootCatalog.flatMap((entry) => [[entry.model, entry], [entry.id, entry]]),
    );
    return capabilities.targets.map((target, priority) => {
      const rootEntry = rootEntries.get(target.model);
      const supportedReasoningEfforts = [...target.efforts]
        .sort((left, right) => effortValue(left) - effortValue(right));
      return {
        model: target.model,
        id: target.model,
        visibility: "list",
        priority: rootEntry?.priority ?? priority,
        defaultReasoningEffort: supportedReasoningEfforts.includes(rootEntry?.defaultReasoningEffort)
          ? rootEntry.defaultReasoningEffort
          : supportedReasoningEfforts[0],
        supportedReasoningEfforts,
      };
    }).sort((left, right) => left.priority - right.priority || left.model.localeCompare(right.model));
  }
  return rootCatalog.flatMap((entry) => {
    const allowedEfforts = CONSERVATIVE_DELEGATE_MODELS.has(entry.model) || CONSERVATIVE_DELEGATE_MODELS.has(entry.id)
      ? new Set(EFFORT_ORDER)
      : null;
    if (!allowedEfforts) return [];
    const supportedReasoningEfforts = entry.supportedReasoningEfforts.filter((effort) => allowedEfforts.has(effort));
    if (!supportedReasoningEfforts.length) return [];
    return [{
      ...entry,
      defaultReasoningEffort: supportedReasoningEfforts.includes(entry.defaultReasoningEffort)
        ? entry.defaultReasoningEffort
        : supportedReasoningEfforts[0],
      supportedReasoningEfforts,
    }];
  });
}

export function selectExplicitRoute(catalog, model, requestedEffort, { effortWasExplicit = false, minimumEffort = null } = {}) {
  const entry = catalog.find((candidate) =>
    candidate.visibility === "list" && (candidate.model === model || candidate.id === model));
  if (!entry) return null;
  if (effortWasExplicit && !entry.supportedReasoningEfforts.includes(requestedEffort)) return null;
  const effort = effortWasExplicit
    ? requestedEffort
    : compatibleEffort(entry, requestedEffort || entry.defaultReasoningEffort, minimumEffort);
  if (!effort) return null;
  return {
    model: entry.model,
    effort,
    family: modelFamily(entry),
    familyFallback: false,
    effortFallback: effort !== requestedEffort,
  };
}

async function hostCatalog() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  try {
    const raw = JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8"));
    return normalizeCatalog(raw?.models || []);
  } catch {
    return [];
  }
}

export async function getModelCatalog({ provided = null, store = null, maxAgeMs = 60 * 60 * 1_000 } = {}) {
  if (provided) return { models: normalizeCatalog(provided), source: "provided" };
  const models = await hostCatalog();
  if (models.length) {
    store?.cacheCatalog(models);
    return { models, source: "host-cache" };
  }
  const cached = store?.cachedCatalog();
  if (cached?.models?.length) {
    return {
      models: normalizeCatalog(cached.models),
      source: Date.now() - cached.fetchedAt <= maxAgeMs ? "router-cache" : "stale-router-cache",
    };
  }
  return { models: [], source: "unavailable" };
}
