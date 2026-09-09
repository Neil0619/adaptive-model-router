import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compatibleToolDefinitions } from "./tool-contract-compatibility.mjs";

/** A previously loaded MCP bootstrap can still compare schemas exactly. Read
 * its original service module (already cached in that process), and export
 * only that reviewed view to the bootstrap. Execution keeps the current
 * schemas; a fresh bridge continues to expose the full current inventory. */
export async function toolDefinitionsForShell(current, serviceUrl, entry = process.argv[1]) {
  if (!entry || !["mcp-server.mjs", "runtime-probe.mjs"].includes(basename(entry))) return current;
  const serviceRoot = realpathSync(resolve(dirname(fileURLToPath(serviceUrl)), "../.."));
  const shellRoot = realpathSync(resolve(dirname(entry), ".."));
  if (shellRoot === serviceRoot) return current;
  const expectedEntry = join(shellRoot, "scripts", basename(entry));
  if (realpathSync(entry) !== realpathSync(expectedEntry)) return current;
  const manifest = JSON.parse(readFileSync(join(shellRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const descriptor = JSON.parse(readFileSync(join(shellRoot, "runtime.json"), "utf8"));
  const candidate = JSON.parse(readFileSync(join(serviceRoot, "runtime.json"), "utf8"));
  if (manifest.name !== "adaptive-model-router" || manifest.version !== descriptor.runtimeVersion
    || descriptor.shellProtocolVersion !== candidate.shellProtocolVersion
    || descriptor.toolContractVersion !== candidate.toolContractVersion
    || descriptor.storageContractVersion !== candidate.storageContractVersion) return current;
  const shell = await import(pathToFileURL(join(shellRoot, "scripts", "lib", "service.mjs")).href);
  return compatibleToolDefinitions(shell.TOOL_DEFINITIONS, current)
    ? structuredClone(shell.TOOL_DEFINITIONS) : current;
}
