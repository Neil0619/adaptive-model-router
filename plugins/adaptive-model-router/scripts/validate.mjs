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
const smokeEvidenceReadme = await readFile(join(repoRoot, "docs", "release-evidence", "README.md"), "utf8");
const smokeEvidenceSchema = await json(join(repoRoot, "docs", "release-evidence", "schema-v1.json"));
const macosEvidenceTemplate = await json(join(repoRoot, "docs", "release-evidence", "templates", "macos-v1.json"));
const smokeEvidenceValidator = await readFile(join(repoRoot, "scripts", "validate-smoke-evidence.mjs"), "utf8");
const installedCandidateVerifier = await readFile(join(repoRoot, "scripts", "verify-installed-candidate.mjs"), "utf8");
const gateContentComparator = await readFile(join(repoRoot, "scripts", "compare-gate-content.mjs"), "utf8");
const windowsSmokeRunnerPath = "scripts/windows-smoke.ps1";
const windowsSmokeRunner = await readFile(join(repoRoot, ...windowsSmokeRunnerPath.split("/")), "utf8");
const codexRouteCli = await readFile(join(pluginRoot, "scripts", "codex-route.mjs"), "utf8");
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
const releaseCandidateRef = "codex/windows-zero-approval-smoke-v9";
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
  assert(
    !document.includes("codex/v040-stop-hook-fix"),
    `${name} still uses the invalidated Stop-hook candidate`,
  );
}
assert(
  /published\s+`stable`\s+remains\s+on\s+v0\.3\.0/u.test(windowsSmoke),
  "Windows smoke must state the published stable version",
);
assert(
  /published\s+`stable`\s+remains\s+on\s+v0\.3\.0/u.test(releaseChecklist),
  "release checklist must state the published stable version",
);
checkObjectSchemas(smokeEvidenceSchema, "smokeEvidence");
assert(smokeEvidenceSchema.properties?.schemaVersion?.const === 1, "smoke evidence schema version must be 1");
assert(smokeEvidenceSchema.properties?.gate?.enum?.includes("macos-native"), "smoke evidence schema must support the blocking macOS gate");
assert(smokeEvidenceSchema.properties?.route?.properties?.verificationGate?.enum?.includes("structured-check"), "smoke evidence schema must preserve structured review gates");
assert(smokeEvidenceSchema.properties?.permissions?.properties?.contract?.enum?.includes("zero-approval-v1"), "smoke evidence schema must expose the Windows zero-approval contract");
for (const counter of ["approvalRequests", "sandboxEscalations", "permissionFailures"]) {
  assert(smokeEvidenceSchema.properties?.permissions?.properties?.[counter]?.minimum === 0, `smoke evidence schema must constrain ${counter}`);
}
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
assert(windowsSmokeRunner.includes("Assert-InstalledPluginBytes"), "Windows smoke runner must compare installed Hook, Skill, MCP, manifest, runtime, and hook implementation bytes");
assert(windowsSmokeRunner.includes("compare-gate-content.mjs"), "Windows smoke runner must compare gate content through the candidate comparator");
assert(windowsSmokeRunner.includes("$InstalledRouterLauncher"), "Windows smoke runner must resolve router state through the installed runtime launcher");
assert(windowsSmokeRunner.includes("@($InstalledRouterLauncher, $InstalledRouterCli"), "Windows smoke runner must read the installed plugin data instead of the legacy Codex Home state root");
assert(windowsSmokeRunner.includes("Write-SmokeFixture -Root $Project"), "Windows smoke runner must seed its deterministic fixture outside the managed read-only Codex session");
assert(windowsSmokeRunner.includes("@('-a', 'never', '-s', 'read-only', 'exec', '-c', $ManagedShellPathConfig, 'resume'"), "Windows smoke runner must keep resumed turns zero-approval, read-only, and on the inherited managed PATH");
assert(windowsSmokeRunner.includes("@('-a', 'never', '-s', 'read-only', 'exec', '-c', $ManagedShellPathConfig, '--json'"), "Windows smoke runner must start new turns zero-approval, read-only, and on the inherited managed PATH");
assert(windowsSmokeRunner.includes("@('-a', 'never', '-s', 'read-only', 'exec', '-c', $ManagedShellPathConfig, '--json', '-C', $Project2"), "Windows smoke runner must keep the cross-project status probe zero-approval and read-only");
assert(!windowsSmokeRunner.includes("@('exec', '-a'"), "Windows smoke runner must place global approval flags before the exec subcommand");
assert(!windowsSmokeRunner.includes("deliberately do not spawn"), "Windows Stop-hook smoke must not ask the model to violate delegated execution");
assert(windowsSmokeRunner.includes("@($InstalledRouterLauncher, $InstalledRouterCli, 'stop-probe', '--confirm', 'STOP_HOOK_SMOKE'"), "Windows smoke runner must seed the Stop-hook route through the installed launcher and plugin-data root");
assert(codexRouteCli.includes("stop-probe requires exact confirmation"), "developer CLI must confirmation-gate the Stop-hook probe");
assert(windowsSmokeRunner.includes("$ManagedCodexPath"), "Windows smoke runner must isolate the managed Codex PATH");
assert(windowsSmokeRunner.includes("shell_environment_policy.set.PATH="), "Windows smoke runner must propagate the managed PATH through Codex turn configuration for bounded subagents");
assert(windowsSmokeRunner.includes("WindowsApps"), "Windows smoke runner must exclude Store app aliases from the managed Codex PATH");
assert(windowsSmokeRunner.includes("$automatedGateEnvironment = @{ CODEX_HOME = $null }"), "Windows smoke runner must isolate the automated gate from the logged-in Codex Home");
assert((windowsSmokeRunner.match(/-EnvironmentOverrides \$automatedGateEnvironment/gu) || []).length === 3, "Windows smoke runner must isolate test, validation, and evaluation from CODEX_HOME");
assert(windowsSmokeRunner.includes(".Environment.Remove([string]$entry.Key)"), "Windows smoke process launcher must support removing inherited environment values");
assert(windowsSmokeRunner.includes("itemType -eq 'command_execution'"), "Windows smoke runner must count structured sandbox command failures");
assert(windowsSmokeRunner.includes("ADAPTIVE_ROUTER_SMOKE_ROOT"), "Windows smoke runner must use one controlled smoke root");
assert(!windowsSmokeRunner.includes("GetTempPath"), "Windows smoke runner must not allocate an undeclared TEMP root");
assert(windowsSmokeRunner.includes("CODEX_PERMISSION_PROFILE"), "Windows smoke runner must require the host permission profile attestation");
assert(windowsSmokeRunner.includes("ADAPTIVE_ROUTER_SMOKE_HOST_APPROVAL_POLICY"), "Windows smoke runner must require the host approval-policy attestation");
assert(windowsSmokeRunner.includes("Register-CodexPermissionTelemetry"), "Windows smoke runner must collect permission telemetry");
assert(windowsSmokeRunner.includes("the native runner performs the executable test immediately after this read-only review"), "Windows smoke runner must separate model review from host-side executable verification");
assert(windowsSmokeRunner.includes("phase=review and evidence review=true"), "Windows smoke runner must route the managed task as a structured review");
assert(windowsSmokeRunner.includes("read-only review did not preserve the structured-check contract"), "Windows smoke runner must bind the review outcome to the structured-check gate");
assert(windowsSmokeRunner.includes("EXPLICIT_TARGET_UNAVAILABLE"), "Windows smoke runner must enforce the current unavailable bounded-target reason code");
assert(!windowsSmokeRunner.includes("EXPLICIT_MODEL_UNAVAILABLE"), "Windows smoke runner must not assert the obsolete unavailable-model reason code");
assert(windowsSmokeRunner.includes("Assert-StructuredReviewSummary"), "Windows smoke runner must validate both managed review checklists");
assert(windowsSmokeRunner.includes("Read-CodexSessionTrace"), "Windows smoke runner must count collaboration lifecycle calls from the dedicated session trace");
assert(windowsSmokeRunner.includes("Read-BoundedSubagentExecution"), "Windows smoke runner must verify the bounded target model and effort from execution metadata");
assert(windowsSmokeRunner.includes("Get-NestedPropertyValue"), "Windows smoke runner must safely inspect mixed session JSONL under strict mode");
assert(windowsSmokeRunner.includes("managed review lifecycle order is not route, spawn, wait completion, outcome"), "Windows smoke runner must enforce delegated lifecycle ordering");
assert(windowsSmokeRunner.includes("fixture changed during managed read-only review"), "Windows smoke runner must prove the deterministic fixture was not mutated by managed review");
assert(windowsSmokeRunner.includes("fixture changed during native executable verification"), "Windows smoke runner must prove the deterministic fixture was not mutated by native tests");
assert(smokeEvidenceValidator.includes('"structured-check"'), "smoke evidence validator must preserve structured review gates");
assert(windowsSmoke.includes("smoke-contract: post-trust-automatic-v1 zero-approval-v1 selector-optional-v1"), "Windows smoke must declare the post-trust zero-approval contract");
assert(!windowsSmoke.includes("blocking manual Windows gate"), "Windows smoke must not describe the canonical gate as manual");
assert(!windowsSmoke.includes("The human operator must"), "Windows smoke must not delegate automated prompts or model changes to the operator");
assert(!windowsSmoke.includes("completed manual report"), "Windows smoke must not require a second manual functional report");
assert(releaseChecklist.includes("smoke-contract: windows-artifact-authoritative-v1 zero-approval-v1 selector-optional-v1"), "release checklist must make zero-approval Windows evidence authoritative and selector checks optional");
assert(smokeEvidenceReadme.includes("smoke-contract: hook-trust-only-human-v1 zero-approval-v1 selector-optional-v1"), "evidence contract must isolate Hook trust from the zero-approval runtime and optional selector evidence");
assert(macosSmoke.includes("smoke-contract: post-trust-agent-owned-v1 selector-optional-v1"), "macOS smoke must use the same post-trust and selector semantics");
assert(!macosSmoke.includes("human-only witness report"), "macOS smoke must not require a human selector report");
assert(windowsSmokeRunner.includes("-Model 'gpt-5.6-terra' -ResumeSession"), "Windows smoke runner must automate a distinct host-model slug");
assert(windowsSmokeRunner.includes("$secondPendingRoutes.Count -ne 1"), "Windows smoke runner must require exactly one second pending route");
assert(windowsSmokeRunner.includes("$postKeepAutomatic.taskMode -ne 'automatic'"), "Windows smoke runner must verify keep-automatic mode");
assert(windowsSmokeRunner.includes("[string]$finalStatus.rootTask.model -ne $InitialRootModel"), "Windows smoke runner must verify initial-model restoration");
assert(!windowsSmokeRunner.includes("--dangerously-bypass-approvals-and-sandbox"), "Windows smoke runner must not bypass command approvals or the managed sandbox");
assert(!windowsSmokeRunner.includes("--dangerously-bypass-hook-trust"), "Windows smoke runner must not bypass Hook trust");
assert(windowsSmokeRunner.includes("System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "Windows smoke runner must use the system script host when a PowerShell script is unavoidable");
assert(windowsSmokeRunner.includes("invoke-command-shim.ps1"), "Windows smoke runner must preserve command-shim argument boundaries under the system script host");
assert(!windowsSmokeRunner.includes("Get-Command -Name 'pwsh'"), "Windows smoke runner must not resolve its script host through a Store pwsh alias");
assert(windowsCommandShim.includes("ValueFromRemainingArguments"), "Windows command shim must preserve argument boundaries");
assert(smokeEvidenceValidator.includes("status disagrees with blocking checks"), "smoke evidence validator must enforce PASS consistency");
assert(macosSmoke.includes("verify-installed-candidate.mjs"), "macOS smoke must verify the installed ref, revision, and version");
assert(macosSmoke.includes("--expected-ref=\"$CandidateRef\"") && macosSmoke.includes("--expected-commit=\"$CandidateCommit\""), "macOS evidence must bind the expected ref and commit");
assert(releaseChecklist.includes("docs/release-evidence/v0.4.0/macos.json"), "release checklist must retain canonical macOS evidence");
assert(installedCandidateVerifier.includes(".codex-marketplace-install.json"), "installed candidate verifier must inspect marketplace metadata");
assert(gateContentComparator.includes("normalizeLineEndings"), "gate comparator must normalize line endings explicitly");
assert(
  /applicable\s+skill's\s+explicit\s+authorization/u.test(windowsSmoke) &&
    /no\s+real\s+SubagentStart\s+occurs/u.test(windowsSmoke),
  "Windows smoke must block unexecuted delegate routes",
);
assert(
  /explicit\s+authorization\s+under\s+conditional\s+multi-agent\s+policies/u.test(macosSmoke),
  "macOS smoke must preserve the shared delegate-authorization contract",
);
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
assert(routerMcp.default_tools_approval_mode === "prompt", "MCP must fail closed for tools without an explicit approval policy");
const autoApprovedTools = [
  "diagnose_router",
  "get_learning_status",
  "get_route_history",
  "get_route_status",
  "list_policy_proposals",
  "record_outcome",
  "resolve_host_model_intent",
  "route_stage",
  "shadow_route_stage",
];
assert(
  JSON.stringify(Object.keys(routerMcp.tools || {}).sort()) === JSON.stringify(autoApprovedTools),
  "MCP may auto-approve only the routing lifecycle and read-only inspection allowlist",
);
for (const tool of autoApprovedTools) {
  assert(routerMcp.tools[tool]?.approval_mode === "approve", `${tool} must be non-interactive after plugin trust`);
}
assert(!JSON.stringify(routerMcp).includes("PLUGIN_ROOT"), "MCP config must not rely on hook-only PLUGIN_ROOT interpolation");
assert(skill.includes("`target.effort` value to the current Codex subagent `reasoning_effort` parameter"), "skill must map router effort to the Codex subagent parameter");
assert(!skill.includes("using exactly `target.model` and `target.effort`"), "skill must not present router output fields as host parameter names");
assert(skill.includes("root-task model is unchanged and host-managed"), "skill must require a visible root/stage model boundary");
assert(skill.includes("global automatic activation"), "skill must document opt-in automatic activation");
assert(!skill.includes("can recommend one bounded subagent model"), "skill must not weaken delegate into a recommendation");
assert(skill.includes("`delegate` is a required action, not a suggestion"), "skill must make delegate mandatory");
assert(
  skill.includes("satisfies conditional multi-agent policies"),
  "skill must treat delegate as explicit authorization under conditional multi-agent policies",
);
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
