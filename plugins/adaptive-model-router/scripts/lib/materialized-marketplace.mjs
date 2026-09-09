import { createHash, randomBytes } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson } from "./io.mjs";

const OWNER = "adaptive-model-router/materialized-marketplace/1";
const RECEIPT = ".adaptive-router-generation.json";
const DIRECTORY = "materialized-marketplace";
const NAME = "adaptive-model-router";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);

function realDirectory(path) {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed marketplace directory is redirected");
}

function files(root, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && entry.name === RECEIPT) continue;
    if (entry.isSymbolicLink()) throw new Error("managed marketplace contains a symbolic link");
    if (entry.isDirectory()) entries.push(...files(root, relative));
    else if (entry.isFile()) entries.push([relative, digest(readFileSync(join(root, relative)))]);
    else throw new Error("managed marketplace contains a non-regular file");
  }
  return entries;
}

export function managedMarketplaceDirectory(dataRoot) {
  return join(resolve(dataRoot), DIRECTORY);
}

export function isManagedMarketplacePath(source, dataRoot) {
  return typeof source === "string" && dirname(resolve(source)) === managedMarketplaceDirectory(dataRoot);
}

export function inspectManagedMarketplace(source, { dataRoot, originalSource = null }) {
  if (!isManagedMarketplacePath(source, dataRoot)) throw new Error("managed marketplace source is outside its owned directory");
  const root = resolve(source);
  realDirectory(resolve(dataRoot));
  realDirectory(managedMarketplaceDirectory(dataRoot));
  realDirectory(root);
  const receiptPath = join(root, RECEIPT);
  if (!lstatSync(receiptPath).isFile() || lstatSync(receiptPath).isSymbolicLink()) throw new Error("managed marketplace receipt is redirected");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const expectedKeys = ["owner", "generation", "originalSource", "runtimeVersion", "treeDigest", "hookDigest"];
  if (!equal(Object.keys(receipt).sort(), expectedKeys.sort()) || receipt.owner !== OWNER ||
      receipt.generation !== basename(root) || !/^generation-[0-9a-f]{24}$/u.test(receipt.generation) ||
      typeof receipt.originalSource !== "string" || resolve(receipt.originalSource) !== receipt.originalSource ||
      (originalSource !== null && resolve(originalSource) !== receipt.originalSource) ||
      !/^[0-9a-f]{64}$/u.test(receipt.treeDigest) || !/^[0-9a-f]{64}$/u.test(receipt.hookDigest)) {
    throw new Error("managed marketplace provenance is invalid");
  }
  const pluginRoot = join(root, "plugins", NAME);
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const runtime = JSON.parse(readFileSync(join(pluginRoot, "runtime.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  if (manifest.name !== NAME || manifest.version !== receipt.runtimeVersion || runtime.runtimeVersion !== receipt.runtimeVersion ||
      !equal(marketplace, marketplaceManifest()) || receipt.treeDigest !== digest(canonicalJson(files(root))) ||
      receipt.hookDigest !== digest(readFileSync(join(pluginRoot, "hooks", "hooks.json")))) {
    throw new Error("managed marketplace generation integrity failed");
  }
  return { root, pluginRoot, receipt };
}

function marketplaceManifest() {
  return { name: NAME, interface: { displayName: "Adaptive Model Router" }, plugins: [{ name: NAME,
    source: { source: "local", path: `./plugins/${NAME}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] };
}

// prepare and verify are supplied by the installer so this module cannot bypass
// its normalized host-surface check or its executable Hook/MCP contract probes.
export function createManagedMarketplace({ dataRoot, sourceRoot, originalSource, prepare, verify }) {
  const parent = managedMarketplaceDirectory(dataRoot);
  realDirectory(resolve(dataRoot));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  realDirectory(parent);
  const generation = `generation-${randomBytes(12).toString("hex")}`;
  const staged = join(parent, `.stage-${generation}`);
  const root = join(parent, generation);
  try {
    realDirectory(resolve(sourceRoot));
    files(sourceRoot);
    const pluginRoot = join(staged, "plugins", NAME);
    mkdirSync(dirname(pluginRoot), { recursive: true, mode: 0o700 });
    cpSync(sourceRoot, pluginRoot, { recursive: true, force: false, errorOnExist: true });
    prepare(pluginRoot);
    verify(pluginRoot);
    mkdirSync(join(staged, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(staged, ".agents", "plugins", "marketplace.json"), `${JSON.stringify(marketplaceManifest(), null, 2)}\n`);
    const runtimeVersion = JSON.parse(readFileSync(join(pluginRoot, "runtime.json"), "utf8")).runtimeVersion;
    const receipt = { owner: OWNER, generation, originalSource: resolve(originalSource), runtimeVersion,
      treeDigest: digest(canonicalJson(files(staged))), hookDigest: digest(readFileSync(join(pluginRoot, "hooks", "hooks.json"))) };
    writeFileSync(join(staged, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(staged, root);
    return inspectManagedMarketplace(root, { dataRoot, originalSource });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

async function userLayer(client, filePath) {
  const response = await client.request("config/read", { includeLayers: true });
  const layers = response?.layers?.filter((layer) => layer?.name?.type === "user" && layer.name.profile == null &&
    layer.name.file === filePath && layer.disabledReason == null);
  if (layers?.length !== 1 || typeof layers[0].version !== "string") throw new Error("native config has no unique base user layer");
  return layers[0];
}

function table(layer) { return layer.config?.marketplaces?.[NAME]; }

async function writeTable(client, filePath, layer, value) {
  const result = await client.request("config/batchWrite", {
    edits: [{ keyPath: `marketplaces.${NAME}`, value, mergeStrategy: "replace" }],
    filePath, expectedVersion: layer.version, reloadUserConfig: false,
  });
  if (result?.status !== "ok") throw new Error(`native marketplace switch status ${result?.status || "unavailable"}`);
}

export async function switchManagedMarketplace({ client, filePath, expectedSource, generation, verify }) {
  try { filePath = realpathSync(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const initial = await userLayer(client, filePath);
  const previous = table(initial);
  if (!previous || previous.source_type !== "local" || previous.source !== expectedSource) {
    throw new Error("native marketplace source conflicts with the reviewed local source");
  }
  const next = { ...previous, source_type: "local", source: generation.root };
  for (const key of ["ref", "ref_name", "refName", "sparse_paths", "sparsePaths", "revision"]) delete next[key];
  let attempted = false;
  try {
    attempted = true;
    await writeTable(client, filePath, initial, next);
    if (!equal(table(await userLayer(client, filePath)), next)) throw new Error("native marketplace switch readback differs");
    await verify();
    return { previous, current: next };
  } catch (error) {
    // Even a failed response can follow a committed write. Never remove a published
    // generation, and never overwrite a concurrently changed table during recovery.
    if (attempted) {
      try {
        const latest = await userLayer(client, filePath);
        if (equal(table(latest), next)) {
          await writeTable(client, filePath, latest, previous);
          if (!equal(table(await userLayer(client, filePath)), previous)) throw new Error("rollback readback differs");
          error.rollback = "restored";
        } else error.rollback = equal(table(latest), previous) ? "unchanged" : "concurrent-source-preserved";
      } catch { error.rollback = "unconfirmed"; }
    }
    error.marketplaceRecovery = { previousSource: previous.source, attemptedSource: generation.root,
      rollback: error.rollback || "not-needed" };
    error.message += `; managed generation retained; rollback=${error.rollback || "not-needed"}`;
    throw error;
  }
}
