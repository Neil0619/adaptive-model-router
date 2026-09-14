import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readRuntimeDescriptor, SHELL_PROTOCOL_VERSION, STORAGE_CONTRACT_VERSION, TOOL_CONTRACT_VERSION } from "./runtime-loader.mjs";
import { scoringWriterProjection } from "./scoring-boundary.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value);

// Every regular file is included (including documentation and descriptors).
// Symlinks, devices and incomplete copies are not runtime packages.
export function inspectRuntimePackage(root, { legacy = false } = {}) {
  if (lstatSync(root).isSymbolicLink()) throw new Error("Runtime root must not be a symlink");
  root = realpathSync(root);
  const files = [];
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name, path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else if (stat.isFile()) files.push([relative, hash(readFileSync(path))]);
      else throw new Error("Runtime packages must contain regular files only");
    }
  }
  visit(root);
  const descriptor = readRuntimeDescriptor(root);
  const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
  if (descriptor.shellProtocolVersion !== (legacy ? 1 : SHELL_PROTOCOL_VERSION) || descriptor.toolContractVersion !== TOOL_CONTRACT_VERSION
    || descriptor.storageContractVersion !== STORAGE_CONTRACT_VERSION || descriptor.databaseVersion !== 10
    || manifest.name !== "adaptive-model-router" || manifest.version !== descriptor.runtimeVersion) {
    throw new Error("Runtime requires a separate cold protocol transition");
  }
  const entrypointNames = new Set(Object.values(descriptor.entrypoints));
  for (const entry of entrypointNames) if (!files.some(([path]) => path === entry)) throw new Error("Runtime entrypoint is absent");
  // Dispatch metadata is executable authority too. Freeze its semantics, not
  // JSON key order or the release label, and include every selected entry's
  // contents even when it lives outside the shared library directory.
  const contract = Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "runtimeVersion")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, key === "entrypoints" ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))) : value]));
  const contractDigest = ["runtime.json#execution-contract", hash(canonical(contract))];
  // Initial admission deliberately freezes writer code, including readers
  // that interpret constraints, enums, encryption and outcomes. Equal version
  // numbers or additive columns alone are not compatibility evidence. Ordinary
  // inferCategory's validated branch program is the pure decision boundary;
  // every other scorer byte stays frozen. Admitted branches still require
  // executable A/B qualification.
  // New writer code needs a reviewed compatibility epoch.
  const writers = files.filter(([path]) => path.startsWith("scripts/lib/") || path === "scripts/hook.mjs" || entrypointNames.has(path)).map(([path, digest]) =>
    path === "scripts/lib/scorer.mjs" && !legacy ? [path, hash(scoringWriterProjection(readFileSync(join(root, path), "utf8")))]
    : path === "scripts/lib/constants.mjs" ? [path, hash(readFileSync(join(root, path), "utf8")
      .replace(/export const ROUTER_VERSION = "[^"]+";/u, 'export const ROUTER_VERSION = "VERSION";'))] : [path, digest]);
  const shellNames = ["scripts/node-launcher.mjs", "scripts/mcp-server.mjs", "scripts/stdio-tool.mjs", "scripts/runtime-admin.mjs",
    "scripts/lib/runtime-loader.mjs", "scripts/lib/runtime-package.mjs", "scripts/lib/runtime-isolation.mjs",
    "scripts/lib/runtime-dispatch.mjs", "scripts/lib/runtime-boundary.mjs", "scripts/verify-runtime-compatibility.mjs", "hooks/hooks.json", ".mcp.json", "runtime-host.json"];
  const shell = files.filter(([path]) => shellNames.includes(path));
  writers.unshift(contractDigest);
  shell.unshift(contractDigest);
  const lifecycle = writers;
  return Object.freeze({ root, directory: basename(root), descriptor, digest: hash(canonical(files)),
    writerDigest: hash(canonical(writers)), shellDigest: hash(canonical(shell)), lifecycleDigest: hash(canonical(lifecycle)) });
}

export function verifyRuntimePackage(record) {
  const actual = inspectRuntimePackage(record.root, { legacy: record.descriptor?.shellProtocolVersion === 1 });
  if (actual.root !== resolve(record.root)) throw new Error("Runtime directory identity was redirected through a symlink");
  if (actual.digest !== record.digest) throw new Error("Runtime content integrity changed; restore the exact retained package");
  return actual;
}

export function managedRuntimeDestination(dataRoot, area, digest) {
  let path = canonicalDestination(dataRoot);
  for (const component of ["runtime-v2", area, digest]) {
    path = join(path, component);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed runtime directory must not be redirected through a symlink");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return path;
}

export function prepareRuntimeCandidate(source, candidateArea, { shellRoot = null } = {}) {
  const inspected = inspectRuntimePackage(source);
  const shell = shellRoot ? inspectRuntimePackage(shellRoot) : null;
  if (shell) {
    const host = JSON.parse(readFileSync(join(shell.root, "runtime-host.json"), "utf8"));
    for (const path of [".mcp.json", "hooks/hooks.json"]) {
      const incoming = hash(readFileSync(join(inspected.root, path)));
      if (!host.sourceEntryDigests?.[path] || ![host.sourceEntryDigests[path], hash(readFileSync(join(shell.root, path)))].includes(incoming)) {
        throw new Error("Source changes the frozen native entry contract; prepare cannot hide that change");
      }
    }
    if (existsSync(join(inspected.root, "runtime-host.json")) && !readFileSync(join(inspected.root, "runtime-host.json")).equals(readFileSync(join(shell.root, "runtime-host.json")))) {
      throw new Error("Source redirects the frozen host data binding");
    }
  }
  const area = canonicalDestination(candidateArea);
  // A version placed beside any legacy cache entry may execute without active.json.
  if (area.split(/[\\/]/u).some((part) => ["cache", "runtime-shell-vault", "published"].includes(part))) {
    throw new Error("Candidate area must be outside every production/legacy discovery tree");
  }
  if (area === inspected.root || area.startsWith(`${inspected.root}/`)) throw new Error("Candidate area must be outside the source package");
  mkdirSync(area, { recursive: true, mode: 0o700 });
  const temporary = join(area, `.prepare-${process.pid}-${inspected.digest}`);
  let destination;
  try {
    cpSync(inspected.root, temporary, { recursive: true, errorOnExist: true, force: false });
    if (inspectRuntimePackage(temporary).digest !== inspected.digest) throw new Error("Candidate changed during copy");
    verifyRuntimePackage(inspected);
    if (shell) {
      for (const path of [".mcp.json", "hooks/hooks.json", "runtime-host.json"]) cpSync(join(shell.root, path), join(temporary, path));
      verifyRuntimePackage(shell);
    }
    destination = join(area, inspectRuntimePackage(temporary).digest);
    try { renameSync(temporary, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || inspectRuntimePackage(destination).digest !== inspectRuntimePackage(temporary).digest) throw error;
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return inspectRuntimePackage(destination);
}

export function copyRuntimePackage(record, destination) {
  destination = canonicalDestination(destination);
  verifyRuntimePackage(record);
  if (existsSync(destination)) {
    // A crash after the complete copy but before the SQLite commit leaves an
    // unindexed exact package. Resume only that digest, never overwrite it.
    verifyRuntimePackage({ ...record, root: destination });
    return { ...record, root: destination };
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(record.root, destination, { recursive: true, force: false, errorOnExist: true });
  try { if (inspectRuntimePackage(destination, { legacy: record.descriptor.shellProtocolVersion === 1 }).digest !== record.digest) throw new Error("Runtime changed during publication"); }
  catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  return { ...record, root: destination };
}

// Resolve the nearest existing ancestor before creating anything. A symlink
// alias into a cache/vault cannot hide a forbidden candidate location.
export function canonicalDestination(path) {
  let ancestor = resolve(path);
  const tail = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Destination parent is unavailable");
    tail.unshift(basename(ancestor)); ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail);
}
