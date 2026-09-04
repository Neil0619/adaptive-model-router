import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { consumeDelegationTicket, observeAgentResult } from "../scripts/lib/delegation-gate.mjs";

export const CATALOG = [
  { slug: "gpt-5.6-sol", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-terra", visibility: "list", priority: 2, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", visibility: "list", priority: 3, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
];

export async function temporaryProject(label = "adaptive-router-test-") {
  const root = await mkdtemp(join(tmpdir(), label));
  return {
    root,
    home: join(root, "state"),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function routeInput(overrides = {}) {
  return {
    goal: "Implement the specified parser with targeted tests.",
    phase: "implementation",
    evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
    contextId: "test-context",
    ...overrides,
  };
}

export async function withRouterEnvironment(project, callback) {
  const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
  const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
  process.env.ADAPTIVE_ROUTER_HOME = project.home;
  process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = "1";
  try {
    return await callback();
  } finally {
    if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
    else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
    if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
    else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
  }
}

let lifecycleSequence = 0;
export function observeNoChildRoute(route, {
  cwd,
  contextId,
  store = null,
} = {}) {
  const ownedStore = store ? null : new RouterStore();
  const activeStore = store || ownedStore;
  try {
    const context = activeStore.context({ cwd, contextId });
    const sequence = ++lifecycleSequence;
    const toolInput = {
      message: route.carrier.message,
      task_name: route.carrier.taskName,
      model: route.target.model,
      reasoning_effort: route.target.effort,
      fork_turns: "none",
    };
    activeStore.transaction(() => consumeDelegationTicket(activeStore.db, context, {
      taskName: route.carrier.taskName,
      turnId: `fixture-turn-${sequence}`,
      toolUseId: `fixture-tool-${sequence}`,
      toolInput,
    }));
    return activeStore.transaction(() => observeAgentResult(activeStore.db, context, {
      turnId: `fixture-turn-${sequence}`,
      toolUseId: `fixture-tool-${sequence}`,
      toolInput,
      toolResponse: { no_agent_created: true },
    }));
  } finally {
    ownedStore?.close();
  }
}

export function completeNoChildRoute(route, {
  cwd,
  contextId,
  store = null,
  status = "passed",
  failureType = null,
  retries = 0,
  retryBreakdown = { reasoning: 0, environment: 0, information: 0, tooling: 0 },
  escalations = route.escalation.count,
  userCorrection = false,
} = {}) {
  const ownedStore = store ? null : new RouterStore();
  const activeStore = store || ownedStore;
  try {
    observeNoChildRoute(route, { cwd, contextId, store: activeStore });
    return recordOutcome({
      routeId: route.routeId,
      contextId,
      status,
      gate: route.verificationGate,
      failureType,
      retries,
      retryBreakdown,
      escalations,
      userCorrection,
    }, { store: activeStore, cwd });
  } finally {
    ownedStore?.close();
  }
}
