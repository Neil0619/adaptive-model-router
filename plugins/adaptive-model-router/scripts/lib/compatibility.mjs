import { readFileSync } from "node:fs";
import { join } from "node:path";

export const COMPATIBILITY_DESCRIPTOR = "compatibility.json";
export const LEGACY_V04_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  liveWorkflowContractVersion: 1,
  stdioBridgeContractVersion: 1,
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCompatibilityDescriptor(value) {
  const expected = [
    "liveWorkflowContractVersion",
    "schemaVersion",
    "stdioBridgeContractVersion",
  ];
  if (
    !isPlainObject(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)
  ) {
    throw new Error("compatibility descriptor has an unsupported shape");
  }
  if (
    value.schemaVersion !== 1 ||
    !Number.isInteger(value.liveWorkflowContractVersion) ||
    value.liveWorkflowContractVersion < 1 ||
    !Number.isInteger(value.stdioBridgeContractVersion) ||
    value.stdioBridgeContractVersion < 1
  ) {
    throw new Error("compatibility descriptor contains invalid values");
  }
  return Object.freeze({ ...value });
}

export function readCompatibilityDescriptor(runtimeRoot) {
  return parseCompatibilityDescriptor(
    JSON.parse(readFileSync(join(runtimeRoot, COMPATIBILITY_DESCRIPTOR), "utf8")),
  );
}

export function sameLiveCompatibility(left, right) {
  return left.liveWorkflowContractVersion === right.liveWorkflowContractVersion &&
    left.stdioBridgeContractVersion === right.stdioBridgeContractVersion;
}
