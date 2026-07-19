#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTER_VERSION } from "./lib/constants.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");

async function walk(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if ([".git", "node_modules", "coverage", "dist"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await walk(child));
    else output.push(child);
  }
  return output;
}

const files = [];
for (const path of await walk(repoRoot)) {
  const data = await readFile(path);
  files.push({
    SPDXID: `SPDXRef-File-${files.length + 1}`,
    fileName: `./${relative(repoRoot, path).replaceAll("\\", "/")}`,
    checksums: [{ algorithm: "SHA256", checksumValue: createHash("sha256").update(data).digest("hex") }],
  });
}

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `adaptive-model-router-${ROUTER_VERSION}`,
  documentNamespace: `https://github.com/Neil0619/adaptive-model-router/releases/tag/v${ROUTER_VERSION}/sbom`,
  creationInfo: { created: new Date().toISOString(), creators: ["Tool: adaptive-model-router-generate-sbom"] },
  packages: [{
    SPDXID: "SPDXRef-Package",
    name: "adaptive-model-router",
    versionInfo: ROUTER_VERSION,
    downloadLocation: "https://github.com/Neil0619/adaptive-model-router",
    filesAnalyzed: true,
    licenseConcluded: "Apache-2.0",
    licenseDeclared: "Apache-2.0",
  }],
  files,
  relationships: files.map((file) => ({ spdxElementId: "SPDXRef-Package", relationshipType: "CONTAINS", relatedSpdxElement: file.SPDXID })),
};

process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
