#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { supportsRuntime } from "./lib/runtime.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkObjectSchemas(schema, path) {
  if (schema.type === "object") assert(schema.additionalProperties === false, `${path} must set additionalProperties:false`);
  for (const [key, child] of Object.entries(schema.properties || {})) checkObjectSchemas(child, `${path}.${key}`);
  if (schema.items) checkObjectSchemas(schema.items, `${path}[]`);
}

assert(supportsRuntime(), "Node.js 24.15.0 or newer is required");
const { TOOL_DEFINITIONS } = await import("./lib/service.mjs");
const manifest = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
const packageJson = await json(join(pluginRoot, "package.json"));
const marketplace = await json(join(repoRoot, ".agents", "plugins", "marketplace.json"));
const hooks = await json(join(pluginRoot, "hooks", "hooks.json"));
assert(manifest.version === packageJson.version, "manifest and package versions differ");
assert(manifest.version === "0.2.0", "release version must be 0.2.0");
assert(packageJson.private === true, "package must remain private");
assert(!packageJson.dependencies && !packageJson.devDependencies, "runtime must have no third-party dependencies");
assert(!Object.hasOwn(manifest, "hooks"), "default hooks/hooks.json discovery should not be duplicated in the manifest");
assert(manifest.mcpServers?.["adaptive-model-router"]?.command === "node", "manifest must inline the stdio MCP server map");
for (const event of ["UserPromptSubmit", "Stop"]) {
  const command = hooks.hooks?.[event]?.[0]?.hooks?.[0];
  assert(typeof command?.commandWindows === "string", `${event} must define commandWindows`);
  assert(command.commandWindows.includes("%PLUGIN_ROOT%") && !command.commandWindows.includes("$PLUGIN_ROOT"), `${event} Windows command must use the Windows plugin root expansion`);
}
const entry = marketplace.plugins?.find((plugin) => plugin.name === manifest.name);
assert(entry?.source?.path === "./plugins/adaptive-model-router", "marketplace source path is invalid");
for (const tool of TOOL_DEFINITIONS) checkObjectSchemas(tool.inputSchema, tool.name);
for (const path of (await files(join(pluginRoot, "scripts"))).filter((path) => path.endsWith(".mjs"))) {
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert(checked.status === 0, `syntax check failed for ${path.slice(pluginRoot.length + 1)}`);
}
process.stdout.write("Adaptive Model Router validation passed.\n");
