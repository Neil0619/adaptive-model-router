import { MIN_NODE } from "./constants.mjs";

export function nodeVersionTuple(version = process.versions.node) {
  return String(version).split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

export function supportsRuntime(version = process.versions.node) {
  const current = nodeVersionTuple(version);
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    if (current[index] > MIN_NODE[index]) return true;
    if (current[index] < MIN_NODE[index]) return false;
  }
  return true;
}

export function assertRuntime() {
  if (!supportsRuntime()) throw new Error("Adaptive Model Router requires Node.js 24.15.0 or newer");
}
