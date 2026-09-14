import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_DESCRIPTOR = "runtime.json";
export const SHELL_PROTOCOL_VERSION = 2;
export const TOOL_CONTRACT_VERSION = 7;
export const STORAGE_CONTRACT_VERSION = 3;
export const RUNTIME_PROBE_TIMEOUT_MS = 5_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeDirectoryName(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value);
}

function safeRelativeEntrypoint(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    /^[A-Za-z0-9._/-]+$/.test(value);
}

export function parseRuntimeDescriptor(value) {
  if (!isPlainObject(value) || !exactKeys(value, [
    "schemaVersion",
    "runtimeVersion",
    "shellProtocolVersion",
    "toolContractVersion",
    "storageContractVersion",
    "databaseVersion",
    "entrypoints",
  ])) {
    throw new Error("runtime descriptor has an unsupported shape");
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.runtimeVersion !== "string" ||
    value.runtimeVersion.length < 1 ||
    value.runtimeVersion.length > 128 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value.runtimeVersion) ||
    !Number.isInteger(value.shellProtocolVersion) ||
    !Number.isInteger(value.toolContractVersion) ||
    !Number.isInteger(value.storageContractVersion) ||
    !Number.isInteger(value.databaseVersion) ||
    value.databaseVersion < 1
  ) {
    throw new Error("runtime descriptor contains invalid values");
  }
  if (!isPlainObject(value.entrypoints) || !exactKeys(value.entrypoints, ["hook", "service", "probe"])) {
    throw new Error("runtime descriptor entrypoints have an unsupported shape");
  }
  for (const entrypoint of Object.values(value.entrypoints)) {
    if (!safeRelativeEntrypoint(entrypoint)) throw new Error("runtime entrypoint is invalid");
  }
  return Object.freeze({
    ...value,
    entrypoints: Object.freeze({ ...value.entrypoints }),
  });
}

export function readRuntimeDescriptor(runtimeRoot) {
  const value = JSON.parse(readFileSync(join(runtimeRoot, RUNTIME_DESCRIPTOR), "utf8"));
  return parseRuntimeDescriptor(value);
}

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(.+))?$/.exec(value);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] || "",
    match[5] || "",
  ];
}

export function compareRuntimeVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  if (a[3] !== b[3]) {
    if (!a[3]) return 1;
    if (!b[3]) return -1;
    return a[3].localeCompare(b[3]);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return -1;
  if (!b[4]) return 1;
  return a[4].localeCompare(b[4]);
}

export function pluginRootFrom(importMetaUrl) {
  let current = dirname(fileURLToPath(importMetaUrl));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(current, RUNTIME_DESCRIPTOR))) return resolve(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("plugin runtime root is unavailable");
}

function compatible(descriptor) {
  return descriptor.shellProtocolVersion === SHELL_PROTOCOL_VERSION &&
    descriptor.toolContractVersion === TOOL_CONTRACT_VERSION &&
    descriptor.storageContractVersion === STORAGE_CONTRACT_VERSION;
}

function candidateAt(root) {
  const descriptor = readRuntimeDescriptor(root);
  if (!compatible(descriptor)) return null;
  const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  if (
    !isPlainObject(manifest) ||
    manifest.name !== "adaptive-model-router" ||
    manifest.version !== descriptor.runtimeVersion
  ) {
    return null;
  }
  const directory = basename(root);
  if (!safeDirectoryName(directory)) return null;
  return Object.freeze({ root, directory, descriptor });
}

// Used by Hook inventory inspection only. No sibling, vault or active.json
// path can become a v2 runtime without explicit registry publication.
export function discoverRuntimeCandidates(currentRoot) {
  try { const current = candidateAt(resolve(currentRoot)); return current ? [current] : []; }
  catch { return []; }
}

export function resolveRuntime(currentRoot) {
  const [current] = discoverRuntimeCandidates(currentRoot);
  if (!current) throw new Error("current runtime descriptor is unavailable or incompatible");
  return { current, active: current, candidate: current, provisional: false,
    activeSource: "stable-shell", activePointerStatus: "explicit-publication-required" };
}

export function runtimeEntrypoint(candidate, name) {
  const relative = candidate.descriptor.entrypoints[name];
  if (!relative) throw new Error("runtime entrypoint is unavailable");
  const path = resolve(candidate.root, relative);
  const rootPrefix = `${resolve(candidate.root)}/`;
  const normalized = path.replaceAll("\\", "/");
  const normalizedRoot = rootPrefix.replaceAll("\\", "/");
  if (!normalized.startsWith(normalizedRoot)) throw new Error("runtime entrypoint escaped its root");
  if (!statSync(path).isFile()) throw new Error("runtime entrypoint is unavailable");
  return path;
}

export function runtimeModuleUrl(candidate, name) {
  return `${pathToFileURL(runtimeEntrypoint(candidate, name)).href}?runtime=${encodeURIComponent(candidate.digest || candidate.descriptor.runtimeVersion)}`;
}

export function runtimePublicState(resolution) {
  return { shellProtocolVersion: SHELL_PROTOCOL_VERSION, toolContractVersion: TOOL_CONTRACT_VERSION,
    storageContractVersion: STORAGE_CONTRACT_VERSION, runtimeVersion: resolution.candidate.descriptor.runtimeVersion,
    activeVersion: resolution.active.descriptor.runtimeVersion, activeSource: "stable-shell",
    activePointerStatus: "explicit-publication-required", databaseVersion: resolution.candidate.descriptor.databaseVersion,
    hotReload: false, taskIsolation: true, provisional: false };
}
