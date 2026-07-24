import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_DESCRIPTOR = "runtime.json";
export const SHELL_PROTOCOL_VERSION = 1;
export const TOOL_CONTRACT_VERSION = 3;
export const STORAGE_CONTRACT_VERSION = 1;
export const RUNTIME_PROBE_TIMEOUT_MS = 4_000;
const POINTER_SCHEMA_VERSION = 1;
const MAX_FAILED_RUNTIMES = 16;
const POINTER_LOCK_TIMEOUT_MS = 2_000;
const POINTER_STALE_LOCK_MS = 30_000;
const pointerWait = new Int32Array(new SharedArrayBuffer(4));

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

function pluginDataRoot(env = process.env) {
  const configured = env.ADAPTIVE_ROUTER_HOME || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  return configured ? resolve(configured) : null;
}

function pointerPath(env = process.env) {
  const root = pluginDataRoot(env);
  return root ? join(root, "runtime", "active.json") : null;
}

function emptyPointer() {
  return {
    schemaVersion: POINTER_SCHEMA_VERSION,
    activeDirectory: null,
    activeVersion: null,
    previousDirectory: null,
    previousVersion: null,
    failedDirectories: [],
  };
}

function parsePointer(value) {
  if (!isPlainObject(value) || !exactKeys(value, Object.keys(emptyPointer()))) return emptyPointer();
  const optionalDirectory = (entry) => entry === null || safeDirectoryName(entry);
  const optionalVersion = (entry) => entry === null ||
    (typeof entry === "string" && entry.length <= 128 && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(entry));
  if (
    value.schemaVersion !== POINTER_SCHEMA_VERSION ||
    !optionalDirectory(value.activeDirectory) ||
    !optionalDirectory(value.previousDirectory) ||
    !optionalVersion(value.activeVersion) ||
    !optionalVersion(value.previousVersion) ||
    !Array.isArray(value.failedDirectories) ||
    value.failedDirectories.some((entry) => !safeDirectoryName(entry))
  ) {
    return emptyPointer();
  }
  return {
    ...value,
    failedDirectories: [...new Set(value.failedDirectories)].slice(-MAX_FAILED_RUNTIMES),
  };
}

function readPointer(env = process.env) {
  const path = pointerPath(env);
  if (!path) return emptyPointer();
  try {
    return parsePointer(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyPointer();
  }
}

function atomicWritePointer(value, env = process.env) {
  const path = pointerPath(env);
  if (!path) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.active-${process.pid}-${randomBytes(5).toString("hex")}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return true;
}

function withPointerLock(env, action) {
  const path = pointerPath(env);
  if (!path) return action();
  const directory = dirname(path);
  const lockPath = join(directory, ".active.lock");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + POINTER_LOCK_TIMEOUT_MS;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > POINTER_STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") throw staleError;
      }
      if (Date.now() >= deadline) throw new Error("runtime pointer is busy");
      Atomics.wait(pointerWait, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
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

export function discoverRuntimeCandidates(currentRoot) {
  const resolvedCurrent = resolve(currentRoot);
  const candidates = [];
  const seen = new Set();
  const add = (root) => {
    const resolved = resolve(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      const candidate = candidateAt(resolved);
      if (candidate) candidates.push(candidate);
    } catch {}
  };
  add(resolvedCurrent);
  try {
    for (const entry of readdirSync(dirname(resolvedCurrent), { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeDirectoryName(entry.name)) continue;
      add(join(dirname(resolvedCurrent), entry.name));
    }
  } catch {}
  return candidates.sort((left, right) =>
    compareRuntimeVersions(right.descriptor.runtimeVersion, left.descriptor.runtimeVersion));
}

function matchingCandidate(candidates, directory, version) {
  return candidates.find((candidate) =>
    candidate.directory === directory && candidate.descriptor.runtimeVersion === version) || null;
}

export function resolveRuntime(currentRoot, { env = process.env, allowTrial = true } = {}) {
  const candidates = discoverRuntimeCandidates(currentRoot);
  const current = candidates.find((candidate) => candidate.root === resolve(currentRoot));
  if (!current) throw new Error("current runtime descriptor is unavailable or incompatible");
  const pointer = readPointer(env);
  const active = matchingCandidate(
    candidates,
    pointer.activeDirectory,
    pointer.activeVersion,
  ) || current;
  if (!allowTrial) return { candidate: active, current, active, pointer, provisional: false };
  const trial = candidates.find((candidate) =>
    !pointer.failedDirectories.includes(candidate.directory) &&
    compareRuntimeVersions(candidate.descriptor.runtimeVersion, active.descriptor.runtimeVersion) > 0);
  return {
    candidate: trial || active,
    current,
    active,
    pointer,
    provisional: Boolean(trial),
  };
}

export function markRuntimeHealthy(resolution, env = process.env) {
  return withPointerLock(env, () => {
    const selected = resolution.candidate;
    const latest = readPointer(env);
    if (
      latest.failedDirectories.includes(selected.directory) ||
      (
        latest.activeVersion &&
        compareRuntimeVersions(latest.activeVersion, selected.descriptor.runtimeVersion) > 0
      )
    ) {
      return latest;
    }
    const latestActiveIsSelected = latest.activeDirectory === selected.directory &&
      latest.activeVersion === selected.descriptor.runtimeVersion;
    const previousDirectory = latestActiveIsSelected
      ? latest.previousDirectory
      : latest.activeDirectory || resolution.active.directory;
    const previousVersion = latestActiveIsSelected
      ? latest.previousVersion
      : latest.activeVersion || resolution.active.descriptor.runtimeVersion;
    const pointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      activeDirectory: selected.directory,
      activeVersion: selected.descriptor.runtimeVersion,
      previousDirectory,
      previousVersion,
      failedDirectories: latest.failedDirectories,
    };
    atomicWritePointer(pointer, env);
    return pointer;
  });
}

export function markRuntimeFailed(resolution, env = process.env) {
  return withPointerLock(env, () => {
    const latest = readPointer(env);
    const failedDirectories = [
      ...latest.failedDirectories.filter((entry) => entry !== resolution.candidate.directory),
      resolution.candidate.directory,
    ].slice(-MAX_FAILED_RUNTIMES);
    const failedActive = latest.activeDirectory === resolution.candidate.directory &&
      latest.activeVersion === resolution.candidate.descriptor.runtimeVersion;
    const pointer = {
      ...latest,
      schemaVersion: POINTER_SCHEMA_VERSION,
      activeDirectory: failedActive
        ? latest.previousDirectory || resolution.current.directory
        : latest.activeDirectory || resolution.active.directory,
      activeVersion: failedActive
        ? latest.previousVersion || resolution.current.descriptor.runtimeVersion
        : latest.activeVersion || resolution.active.descriptor.runtimeVersion,
      previousDirectory: failedActive ? null : latest.previousDirectory,
      previousVersion: failedActive ? null : latest.previousVersion,
      failedDirectories,
    };
    atomicWritePointer(pointer, env);
    return pointer;
  });
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
  return `${pathToFileURL(runtimeEntrypoint(candidate, name)).href}?runtime=${encodeURIComponent(candidate.descriptor.runtimeVersion)}`;
}

export function runtimePublicState(resolution, env = process.env) {
  const pointer = readPointer(env);
  return {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    storageContractVersion: STORAGE_CONTRACT_VERSION,
    runtimeVersion: resolution.candidate.descriptor.runtimeVersion,
    activeVersion: pointer.activeVersion || resolution.candidate.descriptor.runtimeVersion,
    previousVersion: pointer.previousVersion,
    failedRuntimeCount: pointer.failedDirectories.length,
    databaseVersion: resolution.candidate.descriptor.databaseVersion,
    hotReload: true,
    provisional: resolution.provisional,
  };
}
