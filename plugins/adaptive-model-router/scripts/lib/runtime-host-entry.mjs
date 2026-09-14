import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalDestination, inspectRuntimePackage } from "./runtime-package.mjs";
import { renderHookNodeCommand } from "./hook-command.mjs";
import { createHash } from "node:crypto";

// Prepare only. No Codex command, user config, cache, database or registration
// is changed here. This directory becomes the once-registered stable shell;
// future candidates must inherit these exact host adapter bytes.
export function prepareRuntimeHostEntry(source, destination, home) {
  const original = inspectRuntimePackage(source);
  destination = canonicalDestination(destination); home = canonicalDestination(home);
  if (destination.split(/[\\/]/u).some((part) => ["cache", "runtime-shell-vault", "published"].includes(part))) throw new Error("Stable shell must be outside legacy discovery trees");
  if (existsSync(destination)) throw new Error("Stable shell preparation requires a new directory; never rewrite a registered entry");
  const marketplace = dirname(destination), manifest = join(marketplace, ".agents/plugins/marketplace.json");
  if (existsSync(manifest)) throw new Error("Stable shell requires a new dedicated marketplace parent; existing registration metadata is never rewritten");
  if (/["$`\r\n]/u.test(destination) || /["$`\r\n]/u.test(process.execPath)) throw new Error("Native entry path is not representable by the verified Hook command adapter");
  mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
  const write = (path, value) => writeFileSync(join(destination, path), JSON.stringify(value, null, 2) + "\n");
  write("runtime-host.json", { schema: 1, dataHome: home, shellRoot: destination, originalSource: original.root,
    sourceEntryDigests: Object.fromEntries([".mcp.json", "hooks/hooks.json"].map((path) => [path,
      createHash("sha256").update(readFileSync(join(source, path))).digest("hex")])) });
  const mcp = JSON.parse(readFileSync(join(destination, ".mcp.json"), "utf8"));
  Object.assign(mcp.mcpServers["adaptive-model-router"], { command: process.execPath,
    args: [join(destination, "scripts/node-launcher.mjs"), join(destination, "scripts/mcp-server.mjs")], cwd: destination });
  write(".mcp.json", mcp);
  const hooks = JSON.parse(readFileSync(join(destination, "hooks/hooks.json"), "utf8"));
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
    const mode = /\s([a-z-]+)$/u.exec(hook.command)?.[1];
    if (!mode) throw new Error("Unknown Hook command cannot be materialized");
    const suffix = ` "${join(destination, "scripts/node-launcher.mjs")}" "${join(destination, "scripts/hook.mjs")}" ${mode}`;
    hook[process.platform === "win32" ? "commandWindows" : "command"] = renderHookNodeCommand(process.execPath, suffix);
  }
  write("hooks/hooks.json", hooks);
  // A distinct cache identity prevents replacement of the exact installed v1
  // directory during the deferred first native registration.
  for (const [path, field] of [["runtime.json", "runtimeVersion"], [".codex-plugin/plugin.json", "version"]]) {
    const value = JSON.parse(readFileSync(join(destination, path), "utf8")); value[field] += ".runtime2"; write(path, value);
  }
  mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ name: "adaptive-model-router",
    interface: { displayName: "Adaptive Model Router" }, plugins: [{ name: "adaptive-model-router", source: { source: "local", path: `./${destination.split(/[\\/]/u).at(-1)}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] }, null, 2) + "\n");
  return { ...inspectRuntimePackage(destination), marketplace };
}

// Explicit uninstall can run from the source checkout, stable shell or its
// native cache copy. A same-name marketplace alone is never ownership proof.
// Only the dedicated one-plugin parent and the exact prepared binding qualify.
export function ownsRuntimeHostMarketplace(source, installerRoot) {
  try {
    if (typeof source !== "string" || !isAbsolute(source) || lstatSync(source).isSymbolicLink()) return false;
    const marketplace = realpathSync(source), caller = realpathSync(installerRoot);
    const path = join(marketplace, ".agents/plugins/marketplace.json");
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(path, "utf8")), plugin = manifest.plugins?.[0];
    if (manifest.name !== "adaptive-model-router" || manifest.plugins?.length !== 1 || plugin.name !== "adaptive-model-router"
      || plugin.source?.source !== "local" || !/^\.\/[^/\\]+$/u.test(plugin.source.path)) return false;
    const shell = inspectRuntimePackage(resolve(marketplace, plugin.source.path));
    if (dirname(shell.root) !== marketplace) return false;
    const hostBytes = readFileSync(join(shell.root, "runtime-host.json"));
    const host = JSON.parse(hostBytes);
    if (host.schema !== 1 || host.shellRoot !== shell.root || typeof host.originalSource !== "string"
      || !isAbsolute(host.originalSource) || typeof host.dataHome !== "string" || !isAbsolute(host.dataHome)) return false;
    if (caller === host.originalSource || caller === shell.root) return true;
    // A native cache or a published copy inherits this immutable host record.
    return readFileSync(join(caller, "runtime-host.json")).equals(hostBytes);
  } catch { return false; }
}
