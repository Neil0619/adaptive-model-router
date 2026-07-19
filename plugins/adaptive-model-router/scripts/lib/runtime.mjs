import { nodeVersionTuple, supportsNodeRuntime } from "./node-discovery.mjs";

export { nodeVersionTuple };

export function supportsRuntime(version = process.versions.node) {
  return supportsNodeRuntime(version);
}

export function assertRuntime() {
  if (!supportsRuntime()) throw new Error("Adaptive Model Router requires Node.js 24.15.0 or newer");
}
