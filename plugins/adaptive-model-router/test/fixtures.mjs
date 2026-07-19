import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
