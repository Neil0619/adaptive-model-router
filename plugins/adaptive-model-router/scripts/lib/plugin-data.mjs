import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_PLUGIN_DATA_DIRECTORY =
  "adaptive-model-router-adaptive-model-router";

function configuredPluginData(env) {
  return env.ADAPTIVE_ROUTER_HOME || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || null;
}

export function inferInstalledPluginData(importMetaUrl) {
  const scriptsRoot = dirname(fileURLToPath(importMetaUrl));
  const versionRoot = dirname(scriptsRoot);
  const pluginRoot = dirname(versionRoot);
  const marketplaceRoot = dirname(pluginRoot);
  const cacheRoot = dirname(marketplaceRoot);
  const pluginsRoot = dirname(cacheRoot);
  if (
    basename(cacheRoot).toLowerCase() !== "cache" ||
    basename(pluginsRoot).toLowerCase() !== "plugins"
  ) {
    return null;
  }
  return join(
    pluginsRoot,
    "data",
    `${basename(marketplaceRoot)}-${basename(pluginRoot)}`,
  );
}

export function defaultPluginData(env = process.env) {
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  return join(codexHome, "plugins", "data", DEFAULT_PLUGIN_DATA_DIRECTORY);
}

export function environmentWithPluginData(importMetaUrl, env = process.env) {
  const launchEnv = { ...env };
  if (configuredPluginData(launchEnv)) return launchEnv;
  launchEnv.PLUGIN_DATA = inferInstalledPluginData(importMetaUrl) || defaultPluginData(launchEnv);
  return launchEnv;
}
