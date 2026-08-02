#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DATABASE_VERSION, STORAGE_CONTRACT_VERSION } from "./lib/constants.mjs";
import { supportsRuntime } from "./lib/runtime.mjs";
import {
  parseRuntimeDescriptor,
  SHELL_PROTOCOL_VERSION,
  TOOL_CONTRACT_VERSION,
} from "./lib/runtime-loader.mjs";

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
const mcpConfig = await json(join(pluginRoot, ".mcp.json"));
const packageJson = await json(join(pluginRoot, "package.json"));
const runtimeDescriptor = parseRuntimeDescriptor(await json(join(pluginRoot, "runtime.json")));
const marketplace = await json(join(repoRoot, ".agents", "plugins", "marketplace.json"));
const hooks = await json(join(pluginRoot, "hooks", "hooks.json"));
const releaseWorkflow = await readFile(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const releaseChecklist = await readFile(join(repoRoot, "docs", "RELEASE.md"), "utf8");
const windowsSmoke = await readFile(join(repoRoot, "docs", "WINDOWS_SMOKE.md"), "utf8");
const macosSmoke = await readFile(join(repoRoot, "docs", "MACOS_SMOKE.md"), "utf8");
const smokeEvidenceSchema = await json(join(repoRoot, "docs", "release-evidence", "schema-v1.json"));
const macosEvidenceTemplate = await json(join(repoRoot, "docs", "release-evidence", "templates", "macos-v1.json"));
const smokeEvidenceValidator = await readFile(join(repoRoot, "scripts", "validate-smoke-evidence.mjs"), "utf8");
const installedCandidateVerifier = await readFile(join(repoRoot, "scripts", "verify-installed-candidate.mjs"), "utf8");
const gateContentComparator = await readFile(join(repoRoot, "scripts", "compare-gate-content.mjs"), "utf8");
const windowsSmokeRunnerPath = "scripts/windows-smoke.ps1";
const windowsSmokeRunner = await readFile(join(repoRoot, ...windowsSmokeRunnerPath.split("/")), "utf8");
const windowsCommandShim = await readFile(join(repoRoot, "scripts", "invoke-command-shim.ps1"), "utf8");
const skill = await readFile(join(pluginRoot, "skills", "adaptive-model-router", "SKILL.md"), "utf8");
const skillUi = await readFile(join(pluginRoot, "skills", "adaptive-model-router", "agents", "openai.yaml"), "utf8");
assert(manifest.version.split("+")[0] === packageJson.version, "manifest base version and package version differ");
assert(runtimeDescriptor.runtimeVersion === manifest.version, "runtime and manifest versions differ");
assert(runtimeDescriptor.shellProtocolVersion === SHELL_PROTOCOL_VERSION, "runtime shell protocol differs from the pinned shell");
assert(runtimeDescriptor.toolContractVersion === TOOL_CONTRACT_VERSION, "runtime tool contract differs from the pinned shell");
assert(runtimeDescriptor.storageContractVersion === STORAGE_CONTRACT_VERSION, "runtime storage contract differs from the database implementation");
assert(runtimeDescriptor.databaseVersion === DATABASE_VERSION, "runtime database version differs from the database implementation");
assert(runtimeDescriptor.entrypoints.hook === "scripts/hook.mjs", "runtime hook entrypoint is invalid");
assert(runtimeDescriptor.entrypoints.service === "scripts/lib/service.mjs", "runtime service entrypoint is invalid");
assert(runtimeDescriptor.entrypoints.probe === "scripts/runtime-probe.mjs", "runtime probe entrypoint is invalid");
assert(Array.isArray(manifest.interface?.defaultPrompt) && manifest.interface.defaultPrompt.length <= 3, "manifest interface.defaultPrompt must contain at most 3 prompts");
assert(packageJson.version === "0.4.0", "release base version must be 0.4.0");
const releaseTag = `v${packageJson.version}`;
const releaseArtifact = `adaptive-model-router-${releaseTag}`;
const releaseCandidateRef = "codex/windows-smoke";
for (const [name, document] of [
  ["release checklist", releaseChecklist],
  ["Windows smoke", windowsSmoke],
  ["macOS smoke", macosSmoke],
]) {
  assert(document.includes(releaseCandidateRef), `${name} must use ${releaseCandidateRef}`);
  assert(
    !document.includes("codex/v040-shadow-inspection-fix"),
    `${name} still uses the invalidated shadow-inspection candidate`,
  );
}
assert(
  windowsSmoke.includes("published `stable` remains on v0.3.0"),
  "Windows smoke must state the published stable version",
);
assert(
  releaseChecklist.includes("published `stable` remains on v0.3.0"),
  "release checklist must state the published stable version",
);
checkObjectSchemas(smokeEvidenceSchema, "smokeEvidence");
assert(smokeEvidenceSchema.properties?.schemaVersion?.const === 1, "smoke evidence schema version must be 1");
assert(smokeEvidenceSchema.properties?.gate?.enum?.includes("macos-native"), "smoke evidence schema must support the blocking macOS gate");
assert(macosEvidenceTemplate.gate === "macos-native" && macosEvidenceTemplate.status === "FAIL", "macOS evidence template must fail closed");
assert(macosEvidenceTemplate.checks?.length === 16, "macOS evidence template must contain all canonical checks");
assert(
  windowsSmoke.includes("[`" + windowsSmokeRunnerPath + "`](../" + windowsSmokeRunnerPath + ")"),
  "Windows smoke must link the canonical runner",
);
assert(
  windowsSmoke.includes(`.\\${windowsSmokeRunnerPath.replaceAll("/", "\\")}`),
  "Windows smoke PowerShell example must invoke the canonical runner",
);
assert(windowsSmokeRunner.includes("[Parameter(Mandatory = $true)]"), "Windows smoke runner must require a candidate ref");
assert(windowsSmokeRunner.includes("validate-smoke-evidence.mjs"), "Windows smoke runner must validate its evidence");
assert(windowsSmokeRunner.includes("candidate-automated-gate"), "Windows smoke runner must repeat the exact candidate automated gate");
assert(windowsSmokeRunner.includes("Assert-InstalledCandidate"), "Windows smoke runner must verify the installed candidate revision");
assert(windowsSmokeRunner.includes("compare-gate-content.mjs"), "Windows smoke runner must compare gate content through the candidate comparator");
assert(!windowsSmokeRunner.includes("--dangerously-bypass-hook-trust"), "Windows smoke runner must not bypass Hook trust");
assert(windowsSmokeRunner.includes("invoke-command-shim.ps1"), "Windows smoke runner must use the command-shim adapter");
assert(windowsCommandShim.includes("ValueFromRemainingArguments"), "Windows command shim must preserve argument boundaries");
assert(smokeEvidenceValidator.includes("status disagrees with blocking checks"), "smoke evidence validator must enforce PASS consistency");
assert(macosSmoke.includes("verify-installed-candidate.mjs"), "macOS smoke must verify the installed ref, revision, and version");
assert(macosSmoke.includes("--expected-ref=\"$CandidateRef\"") && macosSmoke.includes("--expected-commit=\"$CandidateCommit\""), "macOS evidence must bind the expected ref and commit");
assert(releaseChecklist.includes("docs/release-evidence/v0.4.0/macos.json"), "release checklist must retain canonical macOS evidence");
assert(installedCandidateVerifier.includes(".codex-marketplace-install.json"), "installed candidate verifier must inspect marketplace metadata");
assert(gateContentComparator.includes("normalizeLineEndings"), "gate comparator must normalize line endings explicitly");
const releaseVersions = [...releaseWorkflow.matchAll(/\bv\d+\.\d+\.\d+\b/gu)].map(
  (match) => match[0],
);
assert(releaseVersions.length > 0, "release workflow must pin a semantic release tag");
assert(
  releaseVersions.every((version) => version === releaseTag),
  `release workflow must not reference a version other than ${releaseTag}`,
);
assert(
  releaseWorkflow.includes(`if: github.ref_name == '${releaseTag}'`),
  `release workflow must be gated to ${releaseTag}`,
);
for (const suffix of ["/", ".tar.gz", ".spdx.json"]) {
  assert(
    releaseWorkflow.includes(`${releaseArtifact}${suffix}`),
    `release workflow must reference ${releaseArtifact}${suffix}`,
  );
}
assert(packageJson.private === true, "package must remain private");
assert(!packageJson.dependencies && !packageJson.devDependencies, "runtime must have no third-party dependencies");
assert(!Object.hasOwn(manifest, "hooks"), "default hooks/hooks.json discovery should not be duplicated in the manifest");
assert(manifest.mcpServers === "./.mcp.json", "manifest must reference the root MCP configuration");
const routerMcp = mcpConfig.mcpServers?.["adaptive-model-router"];
assert(routerMcp?.command === "node", "MCP must use the Node command resolved by Codex");
assert(routerMcp.cwd === ".", "MCP cwd must resolve from the plugin root");
assert(routerMcp.args?.[0] === "./scripts/node-launcher.mjs", "MCP must use the relative runtime launcher");
assert(routerMcp.args?.[1] === "./scripts/mcp-server.mjs", "MCP must use the relative server path");
assert(!JSON.stringify(routerMcp).includes("PLUGIN_ROOT"), "MCP config must not rely on hook-only PLUGIN_ROOT interpolation");
assert(skill.includes("`target.effort` value to the current Codex subagent `reasoning_effort` parameter"), "skill must map router effort to the Codex subagent parameter");
assert(!skill.includes("using exactly `target.model` and `target.effort`"), "skill must not present router output fields as host parameter names");
assert(skill.includes("root-task model is unchanged and host-managed"), "skill must require a visible root/stage model boundary");
assert(skill.includes("global automatic activation"), "skill must document opt-in automatic activation");
assert(skill.includes("`resolve_host_model_intent`"), "skill must document host-model intent resolution");
assert(skill.includes("`get_route_history`"), "skill must expose the route history workflow");
assert(skill.includes("already a bounded subagent"), "skill must prevent recursive subagent routing");
assert(skill.includes("do not replay the"), "skill must prevent hook-owned control replay");
assert(skill.includes("Never invent a `contextId`"), "skill must forbid invented router context IDs");
assert(skillUi.includes("$adaptive-model-router"), "skill default prompt must explicitly invoke $adaptive-model-router");
assert(TOOL_DEFINITIONS.some((tool) => tool.name === "get_route_history"), "MCP must expose get_route_history");
assert(TOOL_DEFINITIONS.some((tool) => tool.name === "resolve_host_model_intent"), "MCP must expose host-model intent resolution");
for (const event of ["SubagentStart", "UserPromptSubmit", "Stop"]) {
  const command = hooks.hooks?.[event]?.[0]?.hooks?.[0];
  assert(typeof command?.commandWindows === "string", `${event} must define commandWindows`);
  assert(command.commandWindows.includes("process.env.PLUGIN_ROOT"), `${event} Windows command must read PLUGIN_ROOT inside Node`);
  assert(!["%PLUGIN_ROOT%", "$env:PLUGIN_ROOT", "$PLUGIN_ROOT"].some((value) => command.commandWindows.includes(value)), `${event} Windows command must not use shell-specific plugin root expansion`);
  assert(command.command.includes("node-launcher.mjs") && command.commandWindows.includes("node-launcher.mjs"), `${event} must use the runtime launcher`);
}
const entry = marketplace.plugins?.find((plugin) => plugin.name === manifest.name);
assert(entry?.source?.path === "./plugins/adaptive-model-router", "marketplace source path is invalid");
for (const tool of TOOL_DEFINITIONS) checkObjectSchemas(tool.inputSchema, tool.name);
for (const path of (await files(join(pluginRoot, "scripts"))).filter((path) => path.endsWith(".mjs"))) {
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert(checked.status === 0, `syntax check failed for ${path.slice(pluginRoot.length + 1)}`);
}
for (const path of (await files(join(repoRoot, "scripts"))).filter((path) => path.endsWith(".mjs"))) {
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert(checked.status === 0, `syntax check failed for ${path.slice(repoRoot.length + 1)}`);
}
process.stdout.write("Adaptive Model Router validation passed.\n");
