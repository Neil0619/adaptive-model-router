#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRootFrom } from "./lib/runtime-loader.mjs";

const root = pluginRootFrom(import.meta.url);
const manifestPath = join(root, ".codex-plugin", "plugin.json");
const descriptorPath = join(root, "runtime.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));

if (
  typeof manifest.version !== "string" ||
  manifest.version.length < 1 ||
  typeof descriptor.runtimeVersion !== "string"
) {
  throw new Error("plugin or runtime version is invalid");
}

if (descriptor.runtimeVersion === manifest.version) {
  process.stdout.write(`Runtime version already matches ${manifest.version}.\n`);
  process.exit(0);
}

descriptor.runtimeVersion = manifest.version;
writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
process.stdout.write(`Updated runtime version to ${manifest.version}.\n`);
