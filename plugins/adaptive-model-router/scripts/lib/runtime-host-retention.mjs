import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalDestination } from "./runtime-package.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function tree(root) {
  if (realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) throw new Error("Host retention tree identity changed");
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Host retention refuses symlinks");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push([relative(root, path), hash(readFileSync(path))]);
      else throw new Error("Host retention requires regular files");
    }
  };
  visit(root); return files;
}
function anchorRoot(anchor) {
  const root = realpathSync(anchor);
  if (lstatSync(anchor).isSymbolicLink() || JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"))).name !== "adaptive-model-router"
    || !existsSync(join(root, "runtime.json"))) throw new Error("An exact installed Router anchor is required");
  return dirname(root);
}

// Preserve every historical path, including older protocol generations and
// legacy indices. These bytes are never promoted as a qualified v2 writer.
export function captureRuntimeHostEntries(anchor, destination) {
  const source = anchorRoot(anchor); destination = canonicalDestination(destination);
  if (destination === source || destination.startsWith(source + "/") || destination.split(/[\\/]/u).includes("cache")) throw new Error("Host retention must be outside native caches");
  if (existsSync(destination)) throw new Error("Use a new host retention directory");
  const before = tree(source);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const retained = join(destination, "tree"); cpSync(source, retained, { recursive: true, force: false, errorOnExist: true });
  if (JSON.stringify(before) !== JSON.stringify(tree(retained)) || JSON.stringify(before) !== JSON.stringify(tree(source))) throw new Error("Host entries changed during capture; do not remove the marketplace");
  const receipt = { schema: 1, source, files: before, digest: hash(JSON.stringify(before)) };
  writeFileSync(join(destination, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { archive: destination, source, digest: receipt.digest, files: before.length };
}

export function restoreRuntimeHostEntries(archive, destination) {
  archive = realpathSync(archive); destination = canonicalDestination(destination);
  const receipt = JSON.parse(readFileSync(join(archive, "receipt.json"), "utf8"));
  const retained = join(archive, "tree"), files = tree(retained);
  if (receipt.schema !== 1 || receipt.source !== destination || JSON.stringify(receipt.files) !== JSON.stringify(files)
    || receipt.digest !== hash(JSON.stringify(files))) throw new Error("Host retention path or full content does not match the capture");
  // Validate all conflicts before copying. A new native generation may coexist;
  // an altered historical file is never overwritten to hide that discrepancy.
  for (const [name, digest] of files) {
    const path = join(destination, name);
    if (canonicalDestination(path) !== path) throw new Error("Historical host path was redirected");
    if (existsSync(path) && (!lstatSync(path).isFile() || hash(readFileSync(path)) !== digest)) throw new Error("Historical host entry conflicts with retained bytes");
  }
  let restored = 0;
  for (const [name, digest] of files) {
    const path = join(destination, name);
    if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(retained, name), path, constants.COPYFILE_EXCL); restored++; }
    if (hash(readFileSync(path)) !== digest) throw new Error("Historical host restore verification failed");
  }
  return { source: destination, digest: receipt.digest, files: files.length, restored };
}
