import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { access, chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { supportsRuntime } from "../scripts/lib/runtime.mjs";
import { AGENTS_MARKER_END, AGENTS_MARKER_START } from "../scripts/lib/constants.mjs";
import { DEFAULT_PLUGIN_DATA_DIRECTORY } from "../scripts/lib/plugin-data.mjs";
import { parseHookNodeCommand } from "../scripts/lib/hook-command.mjs";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pluginRoot, "..", "..");
const manager = join(pluginRoot, "scripts", "manage-install.mjs");
const runtimeVersion = JSON.parse(await readFile(join(pluginRoot, "runtime.json"), "utf8")).runtimeVersion;

const FAKE_SOURCE = `
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const path = process.env.FAKE_CODEX_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(path, JSON.stringify(state));
if (args[0] === "--version") { process.stdout.write("codex 1.0.0\\n"); process.exit(0); }
if (args.join(" ") === "plugin marketplace list --json") {
  if (state.failStateReadAfterPluginAdd && state.pluginAddFailed) { process.stderr.write("state unavailable\\n"); process.exit(1); }
  if (state.failStateReadAfterMarketplaceUpgrade && state.marketplaceUpgradeFinished) { process.stderr.write("state unavailable\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({marketplaces:state.marketplaces})); process.exit(0);
}
if (args.join(" ") === "plugin list --available --json") {
  const payload={installed:state.installed,available:state.available};
  if (state.pluginListPaddingBytes) payload.padding="x".repeat(state.pluginListPaddingBytes);
  writeFileSync(1, JSON.stringify(payload)); process.exit(0);
}
if (args.join(" ") === "mcp list --json") {
  const installed = state.installed.find((entry)=>entry.pluginId==="adaptive-model-router@adaptive-model-router");
  const requestedRoot = state.mcpResolvedRoot || installed?.source?.path || state.pluginInstallRoot;
  const root = requestedRoot && existsSync(requestedRoot+"/.mcp.json") ? requestedRoot : installed?.source?.path || state.pluginInstallRoot;
  state.mcpListCalls = (state.mcpListCalls || 0) + 1;
  if (state.damageRuntimeOnMcpListCall === state.mcpListCalls && root) {
    try { unlinkSync(root+"/runtime.json"); } catch {}
  }
  let config = {command:"node",args:["./scripts/node-launcher.mjs","./scripts/mcp-server.mjs"]};
  try { config = JSON.parse(readFileSync(root+"/.mcp.json","utf8")).mcpServers["adaptive-model-router"] || config; } catch {}
  const router = {
    name:"adaptive-model-router", enabled:true, disabled_reason:null,
    transport:{type:"stdio",command:config.command,args:config.args,cwd:root},
  };
  const servers = state.mcpRegistered === false ? [] : [router];
  if (state.duplicateMcpOnMcpListCall === state.mcpListCalls && servers.length > 0) {
    servers.push({...router,transport:{...router.transport,cwd:state.duplicateMcpRoot || root}});
  }
  if (state.makeVersionsRootReadOnlyOnMcpListCall === state.mcpListCalls && root) {
    try { chmodSync(dirname(root),0o500); } catch {}
  }
  save();
  process.stdout.write(JSON.stringify(servers)); process.exit(0);
}
if (args[0] === "app-server") {
  const { createInterface } = await import("node:readline");
  createInterface({input:process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (request.id == null) return;
    const result = request.method === "model/list" ? {data:[{model:"gpt-6-astra",hidden:false,supportedReasoningEfforts:["low","medium","high","xhigh","max","ultra"].map(reasoningEffort=>({reasoningEffort}))}],nextCursor:null} : {};
    process.stdout.write(JSON.stringify({id:request.id,result}) + String.fromCharCode(10));
  });
  await new Promise(resolve => process.stdin.once("end", resolve));
  process.exit(0);
} else if (args[0] === "exec") {
  state.execCalls = (state.execCalls || 0) + 1;
  if (state.rewriteCacheOnExec) {
    for (const root of state.rewriteCacheRoots || [state.pluginInstallRoot]) {
      try { unlinkSync(root+"/runtime.json"); } catch {}
    }
  }
  save();
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"task-tool-smoke"})+"\\n");
  if (state.taskToolExposure !== false) {
    process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"tool-1",type:"mcp_tool_call",tool:"mcp__adaptive_model_router__diagnose_router",status:"completed"}})+"\\n");
    process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"tool-2",type:"mcp_tool_call",tool:"mcp__adaptive_model_router__route_stage",status:"completed"}})+"\\n");
  }
  process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");
  process.exit(0);
}
state.mutations.push(args);
if (args[0] === "plugin" && args[1] === "add" && state.failPluginAdd) {
  state.pluginAddFailed = true;
  if (state.createUnverifiablePluginOnFailure) {
    state.installed = [{pluginId:args[2],name:"adaptive-model-router",marketplaceName:args[2].split("@")[1]}];
  }
  if (state.createPartialPluginOnFailure && state.pluginInstallRoot) {
    state.installed = [{pluginId:args[2],name:"adaptive-model-router",marketplaceName:args[2].split("@")[1],source:{source:"local",path:state.pluginInstallRoot}}];
    try { unlinkSync(state.pluginManifestPath); } catch {}
  }
  if (state.damagePluginCache && state.pluginManifestPath) {
    try { unlinkSync(state.pluginManifestPath); } catch {}
  }
  save();
  process.stderr.write("Error: failed to back up plugin cache entry: Access is denied. (os error 5)\\n");
  process.exit(1);
}
if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const refIndex = args.indexOf("--ref");
  const ref = refIndex >= 0 ? args[refIndex + 1] : null;
  state.marketplaces.push({name:"adaptive-model-router",marketplaceSource:{sourceType:"git",source:"https://github.com/Neil0619/adaptive-model-router.git",ref}});
  state.available=[{pluginId:"adaptive-model-router@adaptive-model-router",name:"adaptive-model-router",marketplaceName:"adaptive-model-router"}];
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  state.marketplaces=state.marketplaces.filter((entry)=>entry.name!==args[3]);
  state.available=state.available.filter((entry)=>entry.marketplaceName!==args[3]);
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "upgrade") {
  if (state.reconcileOnMarketplaceUpgrade && state.reconciledPluginRoot) {
    const entry=state.installed.find((candidate)=>candidate.pluginId==="adaptive-model-router@adaptive-model-router");
    if (entry) entry.source={source:"local",path:state.reconciledPluginRoot};
    state.pluginInstallRoot=state.reconciledPluginRoot;
    state.mcpResolvedRoot=state.reconciledPluginRoot;
    for (const root of state.removeRootsOnMarketplaceUpgrade || []) {
      if (root !== state.reconciledPluginRoot) rmSync(root,{recursive:true,force:true});
    }
  }
  state.marketplaceUpgradeFinished=true;
  if (state.unregisterMcpAfterMarketplaceUpgrade) state.mcpRegistered=false;
  if (state.damageReconciledRuntimeAfterMarketplaceUpgrade && state.reconciledPluginRoot) {
    try { unlinkSync(state.reconciledPluginRoot+"/runtime.json"); } catch {}
  }
  save();
  if (state.failMarketplaceUpgradeAfterReconcile) {
    process.stderr.write("marketplace upgrade failed after reconciliation\\n");
    process.exit(1);
  }
} else if (args[0] === "plugin" && args[1] === "add") {
  if (state.dropDesktopTaskToolsOnPluginAdd) state.desktopTaskTools = false;
  let entry = state.installed.find((candidate)=>candidate.pluginId===args[2]);
  if (!entry) {
    entry={pluginId:args[2],name:"adaptive-model-router",marketplaceName:args[2].split("@")[1]};
    state.installed.push(entry);
  }
  const previousRoot = entry?.source?.path;
  const installedRoot = state.nextPluginInstallRoot || entry?.source?.path || state.pluginInstallRoot;
  if (installedRoot) entry.source={source:"local",path:installedRoot};
  state.pluginInstallRoot = installedRoot;
  if (state.removePreviousOnPluginAdd && previousRoot && previousRoot !== installedRoot) {
    rmSync(previousRoot,{recursive:true,force:true});
  }
  for (const root of state.removeRootsOnPluginAdd || []) {
    if (root !== installedRoot) rmSync(root,{recursive:true,force:true});
  }
} else if (args[0] === "plugin" && args[1] === "remove") {
  state.installed=state.installed.filter((entry)=>entry.pluginId!==args[2]);
}
save();
process.stdout.write("ok\\n");
`;

async function writePluginFixture(root, version = runtimeVersion) {
  await cp(pluginRoot, root, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  manifest.version = version;
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
  const runtime = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
  runtime.runtimeVersion = version;
  await writeFile(join(root, "runtime.json"), JSON.stringify(runtime));
}

async function materializeFixtureCommands(root) {
  const mcpPath = join(root, ".mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  mcp.mcpServers["adaptive-model-router"].command = process.execPath;
  await writeFile(mcpPath, JSON.stringify(mcp));

  const hooksPath = join(root, "hooks", "hooks.json");
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  for (const event of ["SessionStart", "SubagentStart", "UserPromptSubmit", "Stop"]) {
    const handler = hooks.hooks[event][0].hooks[0];
    for (const field of ["command", "commandWindows"]) {
      handler[field] = `"${process.execPath}"${handler[field].slice(handler[field].indexOf(" "))}`;
    }
  }
  await writeFile(hooksPath, JSON.stringify(hooks));
}

async function fakeCodex(project, initial = {}) {
  const bin = join(project.root, "fake bin");
  await mkdir(bin, { recursive: true });
  const source = join(bin, "fake-codex.mjs");
  const statePath = join(project.root, "fake-state.json");
  await writeFile(source, FAKE_SOURCE);
  const pluginInstallRoot = initial.pluginInstallRoot || join(
    project.root,
    "plugins",
    "cache",
    "adaptive-model-router",
    "adaptive-model-router",
    runtimeVersion,
  );
  const pluginManifestPath = initial.pluginManifestPath || join(pluginInstallRoot, ".codex-plugin", "plugin.json");
  await writePluginFixture(pluginInstallRoot);
  const state = {
    marketplaces: [],
    installed: [],
    available: [],
    mutations: [],
    pluginInstallRoot,
    pluginManifestPath,
    ...initial,
  };
  await writeFile(statePath, JSON.stringify(state));
  let executable;
  if (process.platform === "win32") {
    executable = join(bin, "codex.cmd");
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "ascii");
  } else {
    executable = join(bin, "codex");
    await writeFile(executable, `#!${process.execPath}\n${FAKE_SOURCE}`);
    await chmod(executable, 0o755);
  }
  return { executable, statePath, bin };
}

function managerEnvironment(project, fake, {
  useCodexBin = true,
  desktopOverrideDir,
  desktopOverridePathEntry = null,
} = {}) {
  const codexHome = join(project.root, "Codex Home 空格");
  const automaticDesktopOverride = desktopOverrideDir === undefined;
  const effectiveDesktopOverride = automaticDesktopOverride
    ? join(project.root, "Desktop runtime", "dependencies", "bin", "override")
    : desktopOverrideDir;
  if (automaticDesktopOverride) mkdirSync(effectiveDesktopOverride, { recursive: true });
  if (desktopOverridePathEntry) mkdirSync(desktopOverridePathEntry, { recursive: true });
  const env = {
    ...process.env,
    PATH: [desktopOverridePathEntry, fake.bin, process.env.PATH || ""]
      .filter(Boolean)
      .join(delimiter),
    CODEX_HOME: codexHome,
    FAKE_CODEX_STATE: fake.statePath,
  };
  if (useCodexBin) env.CODEX_BIN = fake.executable;
  else {
    delete env.CODEX_BIN;
    // Discovery fixtures must never select an installed native Desktop host.
    if (process.platform === "win32") env.PATH = env.PATH.split(delimiter)
      .filter((directory) => !existsSync(join(directory, "codex.exe"))).join(delimiter);
  }
  if (effectiveDesktopOverride) {
    env.ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR = effectiveDesktopOverride;
  }
  return { codexHome, env };
}

function runManager(project, fake, args = [], options = {}) {
  const { codexHome, env } = managerEnvironment(project, fake, options);
  const result = spawnSync(process.execPath, [manager, ...args], {
    encoding: "utf8",
    env,
  });
  return { ...result, codexHome };
}

async function state(fake) {
  return JSON.parse(await readFile(fake.statePath, "utf8"));
}

function runtimeVault(codexHome) {
  return join(
    codexHome,
    "plugins",
    "data",
    DEFAULT_PLUGIN_DATA_DIRECTORY,
    "runtime-shell-vault",
  );
}

async function marketplacePruneFixture(name, behavior = {}) {
  const project = await temporaryProject(name);
  const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
  const oldVersion = "0.4.0+codex.20260812000000";
  const oldRoot = join(versionsRoot, oldVersion);
  const newRoot = join(versionsRoot, runtimeVersion);
  const installedEntry = {
    pluginId: "adaptive-model-router@adaptive-model-router",
    name: "adaptive-model-router",
    marketplaceName: "adaptive-model-router",
    source: { source: "local", path: oldRoot },
  };
  const fake = await fakeCodex(project, {
    pluginInstallRoot: oldRoot,
    reconciledPluginRoot: newRoot,
    reconcileOnMarketplaceUpgrade: true,
    removeRootsOnMarketplaceUpgrade: [oldRoot],
    marketplaces: [{
      name: "adaptive-model-router",
      marketplaceSource: {
        sourceType: "git",
        source: "https://github.com/Neil0619/adaptive-model-router.git",
        ref: "stable",
      },
    }],
    installed: [installedEntry],
    available: [installedEntry],
    ...behavior,
  });
  await writePluginFixture(oldRoot, oldVersion);
  await writePluginFixture(newRoot, runtimeVersion);
  return { project, fake, oldRoot, oldVersion, newRoot };
}

test("runtime boundary accepts 24.15 and rejects 24.14", () => {
  assert.equal(supportsRuntime("24.14.9"), false);
  assert.equal(supportsRuntime("24.15.0"), true);
  assert.equal(supportsRuntime("25.0.0"), true);
});

test("Windows cache-lock failures tell the operator to exit active Codex sessions", async () => {
  const project = await temporaryProject("adaptive installer cache lock ");
  try {
    const fake = await fakeCodex(project, { failPluginAdd: true });
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /plugin cache is in use on Windows/i);
    assert.match(result.stderr, /fully exit Codex Desktop and every Codex CLI session/i);
    assert.doesNotMatch(result.stderr, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await project.cleanup();
  }
});

test("installer discovers Codex from PATH when CODEX_BIN is unset", async () => {
  const project = await temporaryProject("adaptive installer command discovery ");
  try {
    const fake = await fakeCodex(project);
    const result = runManager(
      project,
      fake,
      ["install", "--non-interactive"],
      { useCodexBin: false },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Adaptive Model Router 0\.4\.0(?:\+codex\.\d+)? is installed/i);
  } finally {
    await project.cleanup();
  }
});

test("cache-lock failures detect a plugin cache that became incomplete during replacement", async () => {
  const project = await temporaryProject("adaptive installer damaged cache ");
  try {
    const cacheRoot = join(project.root, "installed cache 空格");
    const manifestPath = join(cacheRoot, ".codex-plugin", "plugin.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ name: "adaptive-model-router", version: "0.4.0" }));
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: cacheRoot },
    };
    const fake = await fakeCodex(project, {
      failPluginAdd: true,
      damagePluginCache: true,
      pluginManifestPath: manifestPath,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /RECOVERY_REQUIRED/);
    assert.match(result.stderr, /reinstall the exact reviewed ref/i);
    assert.doesNotMatch(result.stderr, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await project.cleanup();
  }
});

test("cache-lock failures treat an uninspectable replacement state as recovery-required damage", async () => {
  const project = await temporaryProject("adaptive installer uninspectable cache ");
  try {
    const fake = await fakeCodex(project, {
      failPluginAdd: true,
      failStateReadAfterPluginAdd: true,
    });
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /RECOVERY_REQUIRED/);
    assert.match(result.stderr, /could not be verified/i);
    assert.doesNotMatch(result.stderr, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await project.cleanup();
  }
});

test("a successful plugin add is rejected when Codex reports an incomplete cache", async () => {
  const project = await temporaryProject("adaptive installer incomplete success ");
  try {
    const cacheRoot = join(project.root, "incomplete installed cache");
    const manifestPath = join(cacheRoot, ".codex-plugin", "plugin.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ name: "adaptive-model-router", version: "0.4.0" }));
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: cacheRoot },
    };
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await rm(join(cacheRoot, "runtime.json"), { force: true });
    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /RECOVERY_REQUIRED/);
    assert.doesNotMatch(result.stderr, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await project.cleanup();
  }
});

test("an installed plugin without a unique MCP cache fails before replacement", async () => {
  const project = await temporaryProject("adaptive installer unverifiable success ");
  try {
    const sourceCheckout = join(project.root, "source checkout that is not the installed cache");
    await writePluginFixture(sourceCheckout);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: sourceCheckout },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: null,
      mcpRegistered: false,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: { sourceType: "git", source: "https://github.com/Neil0619/adaptive-model-router.git", ref: "stable" },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /no unique verifiable MCP cache/i);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("a runtime tree symlink is rejected before any lifecycle mutation", {
  skip: process.platform === "win32" ? "POSIX symlink safety regression" : false,
}, async () => {
  const project = await temporaryProject("adaptive installer runtime symlink safety ");
  try {
    const oldRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router", "0.4.0+codex.20260812000000");
    const outside = join(project.root, "outside-runtime-tree.txt");
    await writeFile(outside, "must remain untouched\n");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    await symlink(outside, join(oldRoot, "runtime-link"));

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.equal(await readFile(outside, "utf8"), "must remain untouched\n");
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("a successful plugin add rejects an internally consistent stale cache version", async () => {
  const project = await temporaryProject("adaptive installer stale cache ");
  try {
    const fake = await fakeCodex(project);
    const fakeState = await state(fake);
    await writeFile(fakeState.pluginManifestPath, JSON.stringify({ name: "adaptive-model-router", version: "0.3.0" }));
    await writeFile(join(fakeState.pluginInstallRoot, "runtime.json"), JSON.stringify({ runtimeVersion: "0.3.0" }));
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /RECOVERY_REQUIRED/);
  } finally {
    await project.cleanup();
  }
});

test("a first-install cache lock reports recovery when a partial cache entry appears", async () => {
  const project = await temporaryProject("adaptive installer first partial lock ");
  try {
    const fake = await fakeCodex(project, { failPluginAdd: true, createPartialPluginOnFailure: true });
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /RECOVERY_REQUIRED/);
  } finally {
    await project.cleanup();
  }
});

test("a first-install cache lock reports recovery for an unverifiable installed entry", async () => {
  const project = await temporaryProject("adaptive installer first unverifiable lock ");
  try {
    const fake = await fakeCodex(project, {
      failPluginAdd: true,
      createUnverifiablePluginOnFailure: true,
      mcpRegistered: false,
      pluginInstallRoot: null,
    });
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.match(result.stderr, /RECOVERY_REQUIRED/);
  } finally {
    await project.cleanup();
  }
});

test("install, upgrade, optional AGENTS patch, and uninstall are idempotent in a Unicode Codex Home", async () => {
  const project = await temporaryProject("adaptive installer Unicode 空格 ");
  try {
    const fake = await fakeCodex(project);
    const codexHome = join(project.root, "Codex Home 空格");
    await mkdir(codexHome, { recursive: true });
    const agents = join(codexHome, "AGENTS.md");
    await writeFile(agents, "User instructions.\n");
    const config = join(codexHome, "config.toml");
    await writeFile(config, "model = \"gpt-5.6-sol\"\n\n[features]\ncodex_hooks = true\nplugins = true\n");

    const installed = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /frozen.*stdio bridge/i);
    assert.match(installed.stdout, /Compatible v0\.4\.x\+ runtime-only updates/);
    assert.match(installed.stdout, /upgrades preserve this setting/);
    assert.match(installed.stdout, /Migrated deprecated features\.codex_hooks/);
    assert.equal(
      await readFile(config, "utf8"),
      "model = \"gpt-5.6-sol\"\n\n[features]\nhooks = true\nplugins = true\n",
    );
    assert.equal(await readFile(agents, "utf8"), "User instructions.\n");
    assert.equal((await state(fake)).installed.length, 1);

    const upgraded = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal((await state(fake)).installed.length, 1);

    assert.equal(runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]).status, 0);
    assert.equal(runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]).status, 0);
    await writeFile(agents, `${await readFile(agents, "utf8")}User edit after the owned block.\n`);
    const patched = await readFile(agents, "utf8");
    assert.equal(patched.split(AGENTS_MARKER_START).length - 1, 1);
    assert.equal(patched.split(AGENTS_MARKER_END).length - 1, 1);
    assert.match(
      patched,
      /action=delegate.*explicitly authorizes and requires exactly one bounded subagent/i,
    );
    assert.match(patched, /not a suggestion/i);

    const removed = runManager(project, fake, ["uninstall", "--non-interactive"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(runManager(project, fake, ["uninstall", "--non-interactive"]).status, 0);
    const finalAgents = await readFile(agents, "utf8");
    assert.equal(finalAgents.includes(AGENTS_MARKER_START), false);
    assert.equal(finalAgents, "User instructions.\nUser edit after the owned block.\n");
    const finalState = await state(fake);
    assert.equal(finalState.installed.length, 0);
    assert.equal(finalState.marketplaces.length, 0);
  } finally {
    await project.cleanup();
  }
});

test("a verified compatible upgrade never starts a cache-reconciling disposable CLI task", async () => {
  const project = await temporaryProject("adaptive installer hot continuity ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      nextPluginInstallRoot: newRoot,
      mcpResolvedRoot: newRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
      rewriteCacheOnExec: true,
      rewriteCacheRoots: [oldRoot],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const result = runManager(project, fake, ["upgrade", "--verify-task-tools", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    await access(oldRoot);
    await access(newRoot);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      "0.4.0+codex.20260812000000",
    );
    const finalState = await state(fake);
    assert.equal(finalState.execCalls || 0, 0);
    assert.deepEqual(finalState.mutations.map((args) => args.join(" ")), [
      "plugin marketplace upgrade adaptive-model-router",
    ]);
    assert.match(result.stdout, /without invoking Codex plugin re-registration/i);
    assert.match(result.stdout, /no disposable Codex CLI task was started/i);
  } finally {
    await project.cleanup();
  }
});

test("a compatible upgrade verifies the staged candidate through the old pinned shell", async () => {
  const project = await temporaryProject("adaptive installer pinned shell candidate probe ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const launcher = join(oldRoot, "scripts", "node-launcher.mjs");
    await cp(launcher, join(oldRoot, "scripts", "node-launcher-original.mjs"));
    await writeFile(launcher, [
      'import { existsSync } from "node:fs";',
      `if (existsSync(${JSON.stringify(join(newRoot, "runtime.json"))})) process.exit(86);`,
      'await import("./node-launcher-original.mjs");',
      "// pinned-shell-candidate-probe",
      "",
    ].join("\n"));

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /(?:MCP_TOOL|HOOK)_CONTRACT_INCOMPLETE/);
    await assert.rejects(access(newRoot), { code: "ENOENT" });
    assert.match(await readFile(launcher, "utf8"), /pinned-shell-candidate-probe/);
  } finally {
    await project.cleanup();
  }
});

test("rollback preserves a valid candidate staged concurrently by another owner", async () => {
  const project = await temporaryProject("adaptive installer concurrent candidate ownership ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    const preparedRoot = join(project.root, "prepared concurrent candidate");
    const candidateUsedMarker = join(project.root, "concurrent candidate was used");
    await writePluginFixture(preparedRoot, runtimeVersion);
    await materializeFixtureCommands(preparedRoot);
    const preparedServer = join(preparedRoot, "scripts", "mcp-server.mjs");
    await cp(preparedServer, join(preparedRoot, "scripts", "mcp-server-original.mjs"));
    await writeFile(preparedServer, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(candidateUsedMarker)}, "used\\n");`,
      'await import("./mcp-server-original.mjs");',
      "",
    ].join("\n"));
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const launcher = join(oldRoot, "scripts", "node-launcher.mjs");
    await cp(launcher, join(oldRoot, "scripts", "node-launcher-original.mjs"));
    await writeFile(launcher, [
      'import { existsSync } from "node:fs";',
      `if (existsSync(${JSON.stringify(candidateUsedMarker)})) process.exit(86);`,
      'await import("./node-launcher-original.mjs");',
      "",
    ].join("\n"));

    const hook = join(oldRoot, "scripts", "hook.mjs");
    await cp(hook, join(oldRoot, "scripts", "hook-original.mjs"));
    await writeFile(hook, [
      'import { cpSync, existsSync } from "node:fs";',
      `if (!existsSync(${JSON.stringify(newRoot)})) cpSync(${JSON.stringify(preparedRoot)}, ${JSON.stringify(newRoot)}, { recursive: true });`,
      'await import("./hook-original.mjs");',
      "",
    ].join("\n"));

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /(?:MCP_TOOL|HOOK)_CONTRACT_INCOMPLETE/);
    assert.equal(
      JSON.parse(await readFile(join(newRoot, "runtime.json"), "utf8")).runtimeVersion,
      runtimeVersion,
    );
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      "0.4.0+codex.20260812000000",
    );
  } finally {
    await project.cleanup();
  }
});

test("a compatible upgrade rejects duplicate enabled Router MCP registrations", async () => {
  const project = await temporaryProject("adaptive installer duplicate MCP registration ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      duplicateMcpOnMcpListCall: 3,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /MCP_REGISTRATION_INCOMPLETE/);
    await assert.rejects(access(newRoot), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, ".mcp.json"), "utf8"))
        .mcpServers["adaptive-model-router"].command,
      "node",
    );
  } finally {
    await project.cleanup();
  }
});

test("duplicate initial Router MCP registrations stop before marketplace mutation", async () => {
  const project = await temporaryProject("adaptive installer initial duplicate MCP registration ");
  try {
    const oldRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router", "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      duplicateMcpOnMcpListCall: 1,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("a compatible upgrade materializes an absolute Node command that starts under the Desktop PATH", async () => {
  const project = await temporaryProject("adaptive installer Desktop PATH ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      mcpResolvedRoot: newRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const desktopOverrideDir = join(project.root, "Desktop runtime", "dependencies", "bin", "override");
    await mkdir(desktopOverrideDir, { recursive: true });
    const result = runManager(
      project,
      fake,
      ["upgrade", "--non-interactive"],
      { desktopOverrideDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Desktop Node compatibility bridge path=/);
    assert.match(result.stdout, /ownership=installer probe=passed/);
    const mcp = JSON.parse(await readFile(join(newRoot, ".mcp.json"), "utf8"))
      .mcpServers["adaptive-model-router"];
    assert.equal(mcp.command, process.execPath);

    const hooks = JSON.parse(await readFile(join(newRoot, "hooks", "hooks.json"), "utf8"));
    const promptHook = hooks.hooks.UserPromptSubmit[0].hooks[0];
    const hookCommand = process.platform === "win32" ? promptHook.commandWindows : promptHook.command;
    assert.equal(parseHookNodeCommand(hookCommand).executable, process.execPath, "installed Hook must use an absolute Node executable");

    const bridgeName = process.platform === "win32" ? "node.cmd" : "node";
    const desktopNodeBridge = await readFile(join(desktopOverrideDir, bridgeName), "utf8");
    assert.match(desktopNodeBridge, /adaptive-model-router Desktop PATH compatibility bridge/);
    assert.ok(desktopNodeBridge.includes(process.execPath));

    const input = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join("\n");
    const desktopLaunch = spawnSync(mcp.command, mcp.args, {
      cwd: newRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "", ADAPTIVE_ROUTER_NODE: process.execPath },
      input: `${input}\n`,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(desktopLaunch.status, 0, desktopLaunch.stderr);
    const responses = desktopLaunch.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const names = responses.find((entry) => entry?.id === 2)?.result?.tools?.map((tool) => tool.name);
    assert.ok(names.includes("route_stage"));
    assert.ok(names.includes("record_outcome"));

    const pluginData = join(project.root, "Desktop plugin data");
    await mkdir(pluginData, { recursive: true });
    const hookShell = process.platform === "win32"
      ? {
          executable: process.env.ComSpec || join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
          args: ["/d", "/s", "/c", `"${hookCommand}"`],
          windowsVerbatimArguments: true,
        }
      : { executable: "/bin/sh", args: ["-c", hookCommand], windowsVerbatimArguments: false };
    const desktopHook = spawnSync(hookShell.executable, hookShell.args, {
      cwd: project.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        PLUGIN_ROOT: newRoot,
        PLUGIN_DATA: pluginData,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: JSON.stringify({
        cwd: project.root,
        session_id: "desktop-path-hook",
        model: "gpt-5.6-sol",
        prompt: "router: global on",
      }),
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: hookShell.windowsVerbatimArguments,
    });
    assert.equal(desktopHook.status, 0, desktopHook.stderr);
    assert.match(
      JSON.parse(desktopHook.stdout).hookSpecificOutput.additionalContext,
      /already been applied atomically by the trusted UserPromptSubmit hook/i,
    );
    if (process.platform === "win32") {
      const powershellHook = spawnSync(
        join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", hookCommand],
        {
          cwd: project.root,
          encoding: "utf8",
          env: { ...process.env, PATH: "", PLUGIN_ROOT: newRoot, PLUGIN_DATA: pluginData, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
          input: JSON.stringify({ cwd: project.root, session_id: "desktop-powershell-hook", model: "gpt-6-astra", prompt: "router: status" }),
          timeout: 15_000,
          windowsHide: true,
        },
      );
      assert.equal(powershellHook.status, 0, powershellHook.stderr);
      assert.ok(JSON.parse(powershellHook.stdout).hookSpecificOutput?.additionalContext);
    }
  } finally {
    await project.cleanup();
  }
});

test("repair recovers a direct-add bare launch contract and survives a later Desktop runtime replacement", async () => {
  const project = await temporaryProject("adaptive installer direct add repair ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const directAddRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const stagedRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(directAddRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: directAddRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: directAddRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(directAddRoot, "0.4.0+codex.20260812000000");
    const initialMcp = JSON.parse(await readFile(join(directAddRoot, ".mcp.json"), "utf8"))
      .mcpServers["adaptive-model-router"];
    assert.equal(initialMcp.command, "node", "fixture must model a raw codex plugin add");

    const desktopOverrideDir = join(project.root, "replaced Desktop runtime", "dependencies", "bin", "override");
    await mkdir(desktopOverrideDir, { recursive: true });
    const repair = runManager(
      project,
      fake,
      ["repair", "--non-interactive"],
      { desktopOverrideDir },
    );
    assert.equal(repair.status, 0, repair.stderr);
    assert.match(repair.stdout, /repaired without plugin re-registration/i);
    assert.deepEqual((await state(fake)).mutations, []);

    const bridgeName = process.platform === "win32" ? "node.cmd" : "node";
    await access(join(desktopOverrideDir, bridgeName));
    await rm(join(desktopOverrideDir, bridgeName), { force: true });

    for (const root of [directAddRoot, stagedRoot]) {
      const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))
        .mcpServers["adaptive-model-router"];
      assert.equal(mcp.command, process.execPath);
      const input = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      ].join("\n");
      const launch = spawnSync(mcp.command, mcp.args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: "", ADAPTIVE_ROUTER_NODE: process.execPath },
        input: `${input}\n`,
        timeout: 15_000,
        windowsHide: true,
      });
      assert.equal(launch.status, 0, launch.stderr);
      const responses = launch.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      const names = responses.find((entry) => entry?.id === 2)?.result?.tools?.map((tool) => tool.name);
      assert.ok(names.includes("route_stage"));
      assert.ok(names.includes("record_outcome"));
    }

    const hooks = JSON.parse(await readFile(join(directAddRoot, "hooks", "hooks.json"), "utf8"));
    const promptHook = hooks.hooks.UserPromptSubmit[0].hooks[0];
    const hookCommand = process.platform === "win32" ? promptHook.commandWindows : promptHook.command;
    assert.equal(parseHookNodeCommand(hookCommand).executable, process.execPath);
    const pluginData = join(project.root, "repair plugin data");
    await mkdir(pluginData, { recursive: true });
    const hookShell = process.platform === "win32"
      ? {
          executable: process.env.ComSpec || join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
          args: ["/d", "/s", "/c", `"${hookCommand}"`],
          windowsVerbatimArguments: true,
        }
      : { executable: "/bin/sh", args: ["-c", hookCommand], windowsVerbatimArguments: false };
    const hookLaunch = spawnSync(hookShell.executable, hookShell.args, {
      cwd: project.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        PLUGIN_ROOT: directAddRoot,
        PLUGIN_DATA: pluginData,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: JSON.stringify({
        cwd: project.root,
        session_id: "runtime-replacement-repair",
        model: "gpt-5.6-sol",
        prompt: "router: global on",
      }),
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: hookShell.windowsVerbatimArguments,
    });
    assert.equal(hookLaunch.status, 0, hookLaunch.stderr);
  } finally {
    await project.cleanup();
  }
});

test("installer accepts a plugin inventory larger than the spawnSync default buffer", async () => {
  const project = await temporaryProject("adaptive installer large inventory ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const installedRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    await writePluginFixture(installedRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: installedRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: installedRoot,
      pluginListPaddingBytes: 2 * 1024 * 1024,
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(installedRoot, "0.4.0+codex.20260812000000");
    const result = runManager(project, fake, ["repair", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /repaired without plugin re-registration/i);
  } finally {
    await project.cleanup();
  }
});

test("hot upgrade discovers the Desktop override directory from PATH without a macOS app executable", async () => {
  const project = await temporaryProject("adaptive installer PATH discovery ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const pathOverride = join(project.root, "portable", "dependencies", "bin", "override");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"], {
      desktopOverrideDir: null,
      desktopOverridePathEntry: pathOverride,
    });
    assert.equal(result.status, 0, result.stderr);
    const bridgeName = process.platform === "win32" ? "node.cmd" : "node";
    assert.match(
      await readFile(join(pathOverride, bridgeName), "utf8"),
      /adaptive-model-router Desktop PATH compatibility bridge/,
    );
  } finally {
    await project.cleanup();
  }
});

test("a compatible upgrade does not invoke Codex plugin re-registration", async () => {
  const project = await temporaryProject("adaptive installer desktop continuity ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      nextPluginInstallRoot: newRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
      desktopTaskTools: true,
      dropDesktopTaskToolsOnPluginAdd: true,
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    await access(oldRoot);
    await access(newRoot);
    const finalState = await state(fake);
    assert.deepEqual(finalState.mutations.map((args) => args.join(" ")), [
      "plugin marketplace upgrade adaptive-model-router",
    ]);
    assert.equal(finalState.desktopTaskTools, true);
    assert.match(result.stdout, /without invoking Codex plugin re-registration/i);
  } finally {
    await project.cleanup();
  }
});

test("a host-surface change refuses hot upgrade before plugin re-registration is invoked", async () => {
  const project = await temporaryProject("adaptive installer host reload ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      nextPluginInstallRoot: newRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
      desktopTaskTools: true,
      dropDesktopTaskToolsOnPluginAdd: true,
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    await writeFile(join(oldRoot, ".mcp.json"), "{}\n");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 6);
    assert.match(result.stderr, /HOST_RELOAD_REQUIRED/);
    const finalState = await state(fake);
    assert.deepEqual(finalState.mutations, []);
    assert.equal(finalState.desktopTaskTools, true);
    await assert.rejects(access(newRoot), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("a plugin manifest UI change refuses hot upgrade before plugin re-registration is invoked", async () => {
  const project = await temporaryProject("adaptive installer manifest reload ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const manifestPath = join(oldRoot, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.interface = { ...manifest.interface, shortDescription: "stale host-visible description" };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    installedManifest.interface = {
      ...installedManifest.interface,
      shortDescription: "stale host-visible description",
    };
    await writeFile(manifestPath, JSON.stringify(installedManifest));

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 6);
    assert.match(result.stderr, /HOST_RELOAD_REQUIRED/);
    assert.deepEqual((await state(fake)).mutations, []);
    await assert.rejects(access(newRoot), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("a live workflow contract change refuses hot upgrade", async () => {
  const project = await temporaryProject("adaptive installer workflow contract ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    await writeFile(join(oldRoot, "compatibility.json"), JSON.stringify({
      schemaVersion: 1,
      liveWorkflowContractVersion: 1,
      stdioBridgeContractVersion: 1,
    }));
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    await writeFile(join(oldRoot, "compatibility.json"), JSON.stringify({
      schemaVersion: 1,
      liveWorkflowContractVersion: 1,
      stdioBridgeContractVersion: 1,
    }));

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 6);
    assert.match(result.stderr, /HOST_RELOAD_REQUIRED/);
    await assert.rejects(access(newRoot), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("a required Desktop node bridge fails before mutating historical shells when its directory is unavailable", async () => {
  const project = await temporaryProject("adaptive installer missing Desktop bridge ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const unavailableOverride = join(project.root, "missing", "Desktop", "override");

    const result = runManager(
      project,
      fake,
      ["upgrade", "--non-interactive"],
      { desktopOverrideDir: unavailableOverride },
    );
    assert.equal(result.status, 5);
    assert.match(result.stderr, /DESKTOP_PATH_BRIDGE_REQUIRED/);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, ".mcp.json"), "utf8"))
        .mcpServers["adaptive-model-router"].command,
      "node",
    );
    await assert.rejects(access(newRoot), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("a Desktop snapshot read failure cleans the complete runtime snapshot before mutation", async () => {
  const project = await temporaryProject("adaptive installer desktop snapshot cleanup ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const desktopOverrideDir = join(project.root, "Desktop runtime", "dependencies", "bin", "override");
    const bridgeName = process.platform === "win32" ? "node.cmd" : "node";
    await mkdir(join(desktopOverrideDir, bridgeName), { recursive: true });
    const beforeSnapshots = new Set((await readdir(tmpdir()))
      .filter((entry) => entry.startsWith("adaptive-router-runtime-backup-")));

    const result = runManager(
      project,
      fake,
      ["upgrade", "--non-interactive"],
      { desktopOverrideDir },
    );
    assert.equal(result.status, 2);
    const afterSnapshots = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith("adaptive-router-runtime-backup-"));
    assert.deepEqual(afterSnapshots.filter((entry) => !beforeSnapshots.has(entry)), []);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, ".mcp.json"), "utf8"))
        .mcpServers["adaptive-model-router"].command,
      "node",
    );
    await assert.rejects(access(newRoot), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("a failed hot-upgrade verification restores complete historical runtime trees", async () => {
  const project = await temporaryProject("adaptive installer transactional repair ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    const legacySkill = `${await readFile(
      join(oldRoot, "skills", "adaptive-model-router", "SKILL.md"),
      "utf8",
    )}\n<!-- historical-shell-marker -->\n`;
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      damageRuntimeOnMcpListCall: 3,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    await writeFile(
      join(oldRoot, "skills", "adaptive-model-router", "SKILL.md"),
      legacySkill,
    );
    await writeFile(join(oldRoot, "compatibility.json"), JSON.stringify({
      schemaVersion: 1,
      liveWorkflowContractVersion: 4,
      stdioBridgeContractVersion: 1,
    }));
    await rm(join(oldRoot, "scripts", "stdio-tool.mjs"), { force: true });
    await rm(join(oldRoot, "scripts", "lib", "plugin-data.mjs"), { force: true });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /MCP_TOOL_CONTRACT_INCOMPLETE/);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, ".mcp.json"), "utf8"))
        .mcpServers["adaptive-model-router"].command,
      "node",
    );
    assert.equal(
      await readFile(join(oldRoot, "skills", "adaptive-model-router", "SKILL.md"), "utf8"),
      legacySkill,
    );
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "compatibility.json"), "utf8")).liveWorkflowContractVersion,
      4,
    );
    await assert.rejects(access(join(oldRoot, "scripts", "stdio-tool.mjs")), { code: "ENOENT" });
    await assert.rejects(access(join(oldRoot, "scripts", "lib", "plugin-data.mjs")), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      "0.4.0+codex.20260812000000",
    );
    await assert.rejects(access(newRoot), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("a rollback failure retains and reports its complete recovery snapshot", {
  skip: process.platform === "win32" ? "POSIX permission failure regression" : false,
}, async () => {
  const project = await temporaryProject("adaptive installer retained rollback snapshot ");
  const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
  const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
  let snapshotPath = null;
  try {
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      damageRuntimeOnMcpListCall: 3,
      makeVersionsRootReadOnlyOnMcpListCall: 3,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /HOT_UPGRADE_ROLLBACK_FAILED/);
    const retained = /recovery snapshot identifier ("(?:[^"\\]|\\.)*")/u.exec(result.stderr);
    assert.ok(retained, result.stderr);
    snapshotPath = join(tmpdir(), JSON.parse(retained[1]));
    await access(snapshotPath);
    assert.equal(
      JSON.parse(await readFile(join(snapshotPath, "0", "runtime.json"), "utf8")).runtimeVersion,
      "0.4.0+codex.20260812000000",
    );
  } finally {
    try {
      await chmod(versionsRoot, 0o700);
    } catch {}
    if (snapshotPath) await rm(snapshotPath, { recursive: true, force: true });
    await project.cleanup();
  }
});

test("compatible upgrade leaves the active immutable cache untouched", async () => {
  const project = await temporaryProject("adaptive installer removed old cache ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");
    await writePluginFixture(newRoot, runtimeVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      nextPluginInstallRoot: newRoot,
      removePreviousOnPluginAdd: true,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, "0.4.0+codex.20260812000000");

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    await access(oldRoot);
    await access(newRoot);
    const preserved = JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8"));
    assert.equal(preserved.runtimeVersion, "0.4.0+codex.20260812000000");
  } finally {
    await project.cleanup();
  }
});

test("compatible upgrade preserves historical runtime identities and refreshes their live old-task bridge", async () => {
  const project = await temporaryProject("adaptive installer all historical caches ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldestRoot = join(versionsRoot, "0.4.0+codex.20260811000000");
    const activeRoot = join(versionsRoot, "0.4.0+codex.20260812000000");
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldestRoot, "0.4.0+codex.20260811000000");
    await writePluginFixture(activeRoot, "0.4.0+codex.20260812000000");
    await writePluginFixture(newRoot, runtimeVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: activeRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: activeRoot,
      nextPluginInstallRoot: newRoot,
      removeRootsOnPluginAdd: [oldestRoot, activeRoot],
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(activeRoot, "0.4.0+codex.20260812000000");
    const legacySkill = `---\nname: adaptive-model-router\ndescription: Choose whether a substantive Codex task stage should continue locally, ask the user, or run as one bounded subagent with a specific available model and reasoning effort. Use at task-stage boundaries, after verification failures, when the user explicitly controls adaptive routing, or when they ask which bounded model target is active or request route/model history.\n---\n\n# Legacy Router Skill\n`;
    for (const root of [oldestRoot, activeRoot]) {
      await writeFile(join(root, "skills", "adaptive-model-router", "SKILL.md"), legacySkill);
      await rm(join(root, "scripts", "stdio-tool.mjs"), { force: true });
      await rm(join(root, "scripts", "lib", "plugin-data.mjs"), { force: true });
    }

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    for (const [root, version] of [
      [oldestRoot, "0.4.0+codex.20260811000000"],
      [activeRoot, "0.4.0+codex.20260812000000"],
      [newRoot, runtimeVersion],
    ]) {
      assert.equal(
        JSON.parse(await readFile(join(root, "runtime.json"), "utf8")).runtimeVersion,
        version,
      );
      assert.match(
        await readFile(join(root, "skills", "adaptive-model-router", "SKILL.md"), "utf8"),
        /Frozen task tool inventory/,
      );
      await access(join(root, "scripts", "stdio-tool.mjs"));
      await access(join(root, "scripts", "lib", "plugin-data.mjs"));
      const hooks = JSON.parse(await readFile(join(root, "hooks", "hooks.json"), "utf8"));
      const prompt = hooks.hooks.UserPromptSubmit[0].hooks[0];
      const command = process.platform === "win32" ? prompt.commandWindows : prompt.command;
      assert.equal(parseHookNodeCommand(command).executable, process.execPath);
    }
  } finally {
    await project.cleanup();
  }
});

test("cold installation archives its verified runtime in stable plugin data", async () => {
  const project = await temporaryProject("adaptive installer cold runtime vault ");
  try {
    const fake = await fakeCodex(project);
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    const vault = runtimeVault(result.codexHome);
    const index = JSON.parse(await readFile(join(vault, "index.json"), "utf8"));
    assert.deepEqual(index, { schemaVersion: 1, directories: [runtimeVersion] });
    assert.equal(
      JSON.parse(await readFile(join(vault, runtimeVersion, "runtime.json"), "utf8")).runtimeVersion,
      runtimeVersion,
    );
  } finally {
    await project.cleanup();
  }
});

test("obsolete but intact runtime archives are preserved and removed from the active index", async () => {
  const project = await temporaryProject("adaptive installer obsolete runtime vault ");
  try {
    const fake = await fakeCodex(project);
    const installed = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(installed.status, 0, installed.stderr);

    const vault = runtimeVault(installed.codexHome);
    const oldVersion = "0.4.0+codex.20260812000000";
    const oldArchive = join(vault, oldVersion);
    await cp(join(vault, runtimeVersion), oldArchive, { recursive: true });

    const manifestPath = join(oldArchive, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = oldVersion;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const runtimePath = join(oldArchive, "runtime.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    runtime.runtimeVersion = oldVersion;
    runtime.toolContractVersion = 3;
    runtime.storageContractVersion = 1;
    runtime.databaseVersion = 3;
    await writeFile(runtimePath, JSON.stringify(runtime));
    await writeFile(join(oldArchive, "compatibility.json"), JSON.stringify({
      schemaVersion: 1,
      liveWorkflowContractVersion: 1,
      stdioBridgeContractVersion: 1,
    }));
    await writeFile(join(oldArchive, "obsolete-archive-marker.txt"), "preserved\n");
    await writeFile(join(vault, "index.json"), `${JSON.stringify({
      schemaVersion: 1,
      directories: [oldVersion, runtimeVersion].sort(),
    })}\n`);
    const mutationsBeforeRepair = [...(await state(fake)).mutations];

    const repaired = runManager(project, fake, ["repair", "--non-interactive"]);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /Preserved 1 obsolete Router runtime archive outside the active compatibility index/iu);
    assert.deepEqual(
      JSON.parse(await readFile(join(vault, "index.json"), "utf8")),
      { schemaVersion: 1, directories: [runtimeVersion] },
    );
    assert.equal(await readFile(join(oldArchive, "obsolete-archive-marker.txt"), "utf8"), "preserved\n");
    assert.equal(
      JSON.parse(await readFile(runtimePath, "utf8")).toolContractVersion,
      3,
    );
    assert.deepEqual((await state(fake)).mutations, mutationsBeforeRepair);
    await assert.rejects(access(join(dirname((await state(fake)).pluginInstallRoot), oldVersion)));
  } finally {
    await project.cleanup();
  }
});

test("repair restores an indexed historical shell across a later host-surface change", async () => {
  const project = await temporaryProject("adaptive installer historical host surface restore ");
  try {
    const fake = await fakeCodex(project);
    const installed = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(installed.status, 0, installed.stderr);

    const vault = runtimeVault(installed.codexHome);
    const currentRoot = (await state(fake)).pluginInstallRoot;
    const versionsRoot = dirname(currentRoot);
    const oldVersion = "0.4.0+codex.20260812000000";
    const oldRoot = join(versionsRoot, oldVersion);
    const oldArchive = join(vault, oldVersion);
    await cp(join(vault, runtimeVersion), oldArchive, { recursive: true });

    const oldManifestPath = join(oldArchive, ".codex-plugin", "plugin.json");
    const oldManifest = JSON.parse(await readFile(oldManifestPath, "utf8"));
    oldManifest.version = oldVersion;
    await writeFile(oldManifestPath, JSON.stringify(oldManifest));
    const oldRuntimePath = join(oldArchive, "runtime.json");
    const oldRuntime = JSON.parse(await readFile(oldRuntimePath, "utf8"));
    oldRuntime.runtimeVersion = oldVersion;
    await writeFile(oldRuntimePath, JSON.stringify(oldRuntime));
    const oldHooksPath = join(oldArchive, "hooks", "hooks.json");
    const oldHooks = JSON.parse(await readFile(oldHooksPath, "utf8"));
    delete oldHooks.hooks.SessionStart;
    const archivedHooks = `${JSON.stringify(oldHooks, null, 2)}\n`;
    await writeFile(oldHooksPath, archivedHooks);
    await writeFile(join(vault, "index.json"), `${JSON.stringify({
      schemaVersion: 1,
      directories: [oldVersion, runtimeVersion].sort(),
    })}\n`);
    await rm(oldRoot, { recursive: true, force: true });

    const repaired = runManager(project, fake, ["repair", "--non-interactive"]);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /Restored 1 compatible historical Router runtime shell/iu);
    assert.equal(await readFile(join(oldRoot, "hooks", "hooks.json"), "utf8"), archivedHooks);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      oldVersion,
    );
    assert.equal(
      JSON.parse(await readFile(join(currentRoot, "runtime.json"), "utf8")).runtimeVersion,
      runtimeVersion,
    );
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin marketplace add Neil0619/adaptive-model-router --ref stable",
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);

    const currentArchiveHooksPath = join(vault, runtimeVersion, "hooks", "hooks.json");
    const currentArchiveHooks = JSON.parse(await readFile(currentArchiveHooksPath, "utf8"));
    const verifiedCurrentArchiveHooks = structuredClone(currentArchiveHooks);
    currentArchiveHooks.untrustedCurrentSurface = true;
    await writeFile(currentArchiveHooksPath, JSON.stringify(currentArchiveHooks));
    const rejected = runManager(project, fake, ["repair", "--non-interactive"]);
    assert.equal(rejected.status, 5);
    assert.match(rejected.stderr, /RUNTIME_VAULT_DAMAGED/iu);
    assert.equal(
      JSON.parse(await readFile(join(currentRoot, "runtime.json"), "utf8")).runtimeVersion,
      runtimeVersion,
    );

    await writeFile(currentArchiveHooksPath, JSON.stringify(verifiedCurrentArchiveHooks));
    await rm(oldRoot, { recursive: true, force: true });
    const unknownEventHooks = structuredClone(oldHooks);
    unknownEventHooks.hooks.FutureEvent = unknownEventHooks.hooks.Stop;
    await writeFile(oldHooksPath, JSON.stringify(unknownEventHooks));
    const unknownEvent = runManager(project, fake, ["repair", "--non-interactive"]);
    assert.equal(unknownEvent.status, 5);
    assert.match(unknownEvent.stderr, /RUNTIME_VAULT_RESTORE_FAILED/iu);

    await rm(oldRoot, { recursive: true, force: true });
    const missingBaseEventHooks = structuredClone(oldHooks);
    delete missingBaseEventHooks.hooks.Stop;
    await writeFile(oldHooksPath, JSON.stringify(missingBaseEventHooks));
    const missingBaseEvent = runManager(project, fake, ["repair", "--non-interactive"]);
    assert.equal(missingBaseEvent.status, 5);
    assert.match(missingBaseEvent.stderr, /RUNTIME_VAULT_RESTORE_FAILED/iu);
  } finally {
    await project.cleanup();
  }
});

test("marketplace reconciliation can prune an old cache before the installer restores it", async () => {
  const project = await temporaryProject("adaptive installer marketplace prune recovery ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldVersion = "0.4.0+codex.20260812000000";
    const oldRoot = join(versionsRoot, oldVersion);
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, oldVersion);
    await writePluginFixture(newRoot, runtimeVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      reconciledPluginRoot: newRoot,
      reconcileOnMarketplaceUpgrade: true,
      removeRootsOnMarketplaceUpgrade: [oldRoot],
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, oldVersion);
    await writePluginFixture(newRoot, runtimeVersion);

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Restored 1 compatible historical Router runtime shell/);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      oldVersion,
    );
    const finalState = await state(fake);
    assert.equal(finalState.mcpResolvedRoot, newRoot);
    assert.equal(
      finalState.mutations.some((args) => args.join(" ") === "plugin add adaptive-model-router@adaptive-model-router"),
      false,
    );
  } finally {
    await project.cleanup();
  }
});

test("marketplace failures after pruning restore every archived old-task runtime", async (t) => {
  const scenarios = [
    {
      name: "upgrade command failure",
      behavior: { failMarketplaceUpgradeAfterReconcile: true },
      expected: /plugin marketplace upgrade adaptive-model-router failed/iu,
    },
    {
      name: "post-upgrade state read failure",
      behavior: { failStateReadAfterMarketplaceUpgrade: true },
      expected: /plugin marketplace list --json failed/iu,
    },
    {
      name: "missing post-upgrade MCP registration",
      behavior: { unregisterMcpAfterMarketplaceUpgrade: true },
      expected: /CACHE_DAMAGED: RECOVERY_REQUIRED/iu,
    },
    {
      name: "damaged post-upgrade runtime",
      behavior: { damageReconciledRuntimeAfterMarketplaceUpgrade: true },
      expected: /CACHE_DAMAGED: RECOVERY_REQUIRED/iu,
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await marketplacePruneFixture(
        `adaptive installer marketplace recovery ${scenario.name} `,
        scenario.behavior,
      );
      try {
        const result = runManager(fixture.project, fixture.fake, ["upgrade", "--non-interactive"]);
        assert.equal(result.status, 5);
        assert.match(result.stderr, scenario.expected);
        assert.match(result.stderr, /restored [1-9]\d* missing or damaged historical Router runtime shells?/iu);
        assert.equal(
          JSON.parse(await readFile(join(fixture.oldRoot, "runtime.json"), "utf8")).runtimeVersion,
          fixture.oldVersion,
        );
      } finally {
        await fixture.project.cleanup();
      }
    });
  }
});

test("marketplace recovery refuses a symlinked restore workspace without touching its target", {
  skip: process.platform === "win32" ? "POSIX symlink safety regression" : false,
}, async () => {
  const fixture = await marketplacePruneFixture(
    "adaptive installer marketplace symlink recovery ",
    { failMarketplaceUpgradeAfterReconcile: true },
  );
  try {
    const outside = join(fixture.project.root, "outside restore target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "marker.txt"), "untouched\n");
    const recoveryPath = join(dirname(fixture.oldRoot), ".adaptive-router-vault-restore");
    await symlink(outside, recoveryPath);

    const result = runManager(fixture.project, fixture.fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /MARKETPLACE_RECOVERY_FAILED/iu);
    assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "untouched\n");
    assert.deepEqual(await readdir(outside), ["marker.txt"]);
  } finally {
    await fixture.project.cleanup();
  }
});

test("the installer lifecycle lock serializes processes and releases after a crash", {
  // Two complete installs plus the five-second contention deadline exceed
  // twenty seconds on native Windows; all lock and recovery assertions remain.
  timeout: 60_000,
}, async () => {
  const fixture = await marketplacePruneFixture("adaptive installer lifecycle lock crash recovery ");
  let holder = null;
  try {
    const prepared = runManager(fixture.project, fixture.fake, ["upgrade", "--non-interactive"]);
    assert.equal(prepared.status, 0, prepared.stderr);
    await rm(fixture.oldRoot, { recursive: true, force: true });
    const lockDatabase = join(dirname(runtimeVault(prepared.codexHome)), "installer-lifecycle.sqlite3");
    const holderSource = [
      'const { DatabaseSync } = require("node:sqlite");',
      "const database = new DatabaseSync(process.argv[1]);",
      "database.exec('BEGIN IMMEDIATE;');",
      "process.stdout.write('locked\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    holder = spawn(process.execPath, ["-e", holderSource, lockDatabase], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    holder.stdout.setEncoding("utf8");
    await new Promise((resolveLocked, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", (chunk) => {
        if (chunk.trim() === "locked") resolveLocked();
        else reject(new Error("lifecycle lock holder did not start"));
      });
    });

    const contender = runManager(fixture.project, fixture.fake, ["upgrade", "--non-interactive"]);
    assert.equal(contender.status, 5);
    assert.match(contender.stderr, /INSTALLER_LIFECYCLE_BUSY/iu);

    const holderExit = new Promise((resolveExit) => holder.once("exit", resolveExit));
    holder.kill();
    await holderExit;
    const recovered = runManager(fixture.project, fixture.fake, ["upgrade", "--non-interactive"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Restored 1 compatible historical Router runtime shell/iu);
    assert.equal(
      JSON.parse(await readFile(join(fixture.oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      fixture.oldVersion,
    );
    const index = JSON.parse(await readFile(join(runtimeVault(recovered.codexHome), "index.json"), "utf8"));
    assert.deepEqual(index.directories, [fixture.oldVersion, runtimeVersion].sort());
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill();
    await fixture.project.cleanup();
  }
});

test("a later hot upgrade restores indexed historical shells pruned by the host", async () => {
  const project = await temporaryProject("adaptive installer stable runtime vault restore ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldVersion = "0.4.0+codex.20260812000000";
    const orphanVersion = "0.4.0+codex.20260811000000";
    const oldRoot = join(versionsRoot, oldVersion);
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, oldVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, oldVersion);

    const first = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(first.status, 0, first.stderr);
    const vault = runtimeVault(first.codexHome);
    const firstIndex = JSON.parse(await readFile(join(vault, "index.json"), "utf8"));
    assert.deepEqual(firstIndex.directories, [oldVersion, runtimeVersion].sort());
    const immutableArchiveMarker = join(vault, oldVersion, "archive-identity-marker.txt");
    await writeFile(immutableArchiveMarker, "original immutable archive\n");

    const orphanVaultRoot = join(vault, orphanVersion);
    await cp(join(vault, oldVersion), orphanVaultRoot, { recursive: true });
    const orphanManifestPath = join(orphanVaultRoot, ".codex-plugin", "plugin.json");
    const orphanManifest = JSON.parse(await readFile(orphanManifestPath, "utf8"));
    orphanManifest.version = orphanVersion;
    await writeFile(orphanManifestPath, JSON.stringify(orphanManifest));
    const orphanRuntimePath = join(orphanVaultRoot, "runtime.json");
    const orphanRuntime = JSON.parse(await readFile(orphanRuntimePath, "utf8"));
    orphanRuntime.runtimeVersion = orphanVersion;
    await writeFile(orphanRuntimePath, JSON.stringify(orphanRuntime));

    await rm(oldRoot, { recursive: true, force: true });
    const fakeState = await state(fake);
    fakeState.mcpResolvedRoot = newRoot;
    await writeFile(fake.statePath, JSON.stringify(fakeState));

    const second = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Restored 1 compatible historical Router runtime shell/);
    assert.equal(
      JSON.parse(await readFile(join(oldRoot, "runtime.json"), "utf8")).runtimeVersion,
      oldVersion,
    );
    assert.match(
      await readFile(join(oldRoot, "skills", "adaptive-model-router", "SKILL.md"), "utf8"),
      /Frozen task tool inventory/,
    );
    assert.equal(await readFile(immutableArchiveMarker, "utf8"), "original immutable archive\n");
    await assert.rejects(access(join(versionsRoot, orphanVersion)));
    assert.equal(
      (await state(fake)).mutations.some((args) => args.join(" ") === "plugin add adaptive-model-router@adaptive-model-router"),
      false,
    );
  } finally {
    await project.cleanup();
  }
});

test("an indexed vault symlink fails closed before cache or registration mutation", {
  skip: process.platform === "win32" ? "POSIX symlink safety regression" : false,
}, async () => {
  const project = await temporaryProject("adaptive installer runtime vault symlink ");
  try {
    const versionsRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router");
    const oldVersion = "0.4.0+codex.20260812000000";
    const oldRoot = join(versionsRoot, oldVersion);
    const newRoot = join(versionsRoot, runtimeVersion);
    await writePluginFixture(oldRoot, oldVersion);
    const installedEntry = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: oldRoot },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: oldRoot,
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
          ref: "stable",
        },
      }],
      installed: [installedEntry],
      available: [installedEntry],
    });
    await writePluginFixture(oldRoot, oldVersion);

    const first = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(first.status, 0, first.stderr);
    const vault = runtimeVault(first.codexHome);
    const outside = join(project.root, "outside-vault-target");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "unchanged\n");
    await rm(join(vault, oldVersion), { recursive: true, force: true });
    await symlink(outside, join(vault, oldVersion));
    await rm(oldRoot, { recursive: true, force: true });
    const fakeState = await state(fake);
    fakeState.mcpResolvedRoot = newRoot;
    const mutationsBeforeFailure = [...fakeState.mutations];
    await writeFile(fake.statePath, JSON.stringify(fakeState));

    const second = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(second.status, 5);
    assert.match(second.stderr, /RUNTIME_VAULT_DAMAGED/);
    assert.deepEqual((await state(fake)).mutations, mutationsBeforeFailure);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "unchanged\n");
    await assert.rejects(access(oldRoot));
  } finally {
    await project.cleanup();
  }
});

test("installation fails closed when the Router MCP is not registered for new tasks", async () => {
  const project = await temporaryProject("adaptive installer missing MCP registration ");
  try {
    const fake = await fakeCodex(project, { mcpRegistered: false });
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /PLUGIN_INSTALL_INCOMPLETE/);
  } finally {
    await project.cleanup();
  }
});

test("optional logged-in smoke verifies Router tool calls in a disposable Codex CLI task", async () => {
  const project = await temporaryProject("adaptive installer task tool smoke ");
  try {
    const fake = await fakeCodex(project);
    const result = runManager(project, fake, ["install", "--verify-task-tools", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /disposable Codex CLI task completed live/i);
  } finally {
    await project.cleanup();
  }
});

test("logged-in smoke fails when a new Codex task cannot call Router tools", async () => {
  const project = await temporaryProject("adaptive installer missing task tools ");
  try {
    const fake = await fakeCodex(project, { taskToolExposure: false });
    const result = runManager(project, fake, ["install", "--verify-task-tools", "--non-interactive"]);
    assert.equal(result.status, 7);
    assert.match(result.stderr, /TASK_TOOL_EXPOSURE_MISSING/);
  } finally {
    await project.cleanup();
  }
});

test("AGENTS patch and uninstall preserve the original content exactly", async () => {
  const project = await temporaryProject("adaptive installer exact AGENTS 空格 ");
  try {
    const fake = await fakeCodex(project);
    const codexHome = join(project.root, "Codex Home 空格");
    await mkdir(codexHome, { recursive: true });
    const agents = join(codexHome, "AGENTS.md");
    const originals = [
      "User instructions.\n",
      "User instructions.",
      "Windows instructions.\r\n\r\n",
      "",
    ];

    for (const original of originals) {
      await writeFile(agents, original);
      const installed = runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]);
      assert.equal(installed.status, 0, installed.stderr);
      const removed = runManager(project, fake, ["uninstall", "--non-interactive"]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(await readFile(agents, "utf8"), original);
    }

    await rm(agents, { force: true });
    const installedWithoutFile = runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]);
    assert.equal(installedWithoutFile.status, 0, installedWithoutFile.stderr);
    const removedWithoutFile = runManager(project, fake, ["uninstall", "--non-interactive"]);
    assert.equal(removedWithoutFile.status, 0, removedWithoutFile.stderr);
    await assert.rejects(access(agents), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("upgrade accepts the current Codex marketplace shape using install metadata for the stable ref", async () => {
  const project = await temporaryProject("adaptive marketplace metadata Unicode 空格 ");
  try {
    const marketplaceRoot = join(project.root, "marketplace cache 中文");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(join(marketplaceRoot, ".codex-marketplace-install.json"), JSON.stringify({
      source_type: "git",
      source: "https://github.com/Neil0619/adaptive-model-router.git",
      ref_name: "stable",
      revision: "0123456789abcdef",
    }));
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [{
        pluginId: "adaptive-model-router@adaptive-model-router",
        name: "adaptive-model-router",
        marketplaceName: "adaptive-model-router",
      }],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin marketplace upgrade adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("upgrade accepts the exact local repository marketplace without replacing or refreshing it", async () => {
  const project = await temporaryProject("adaptive exact local marketplace ");
  try {
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        marketplaceSource: { sourceType: "local", source: repoRoot },
      }],
    });
    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("upgrade recognizes the native CLI local marketplace root without source metadata", async () => {
  const project = await temporaryProject("adaptive native local marketplace ");
  try {
    const fake = await fakeCodex(project, {
      marketplaces: [{ name: "adaptive-model-router", root: repoRoot }],
    });
    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);
  } finally { await project.cleanup(); }
});

test("native local marketplace roots never override a foreign or explicit source", async () => {
  for (const entry of [
    { root: tmpdir() },
    { root: repoRoot, marketplaceSource: { sourceType: "git", source: "someone/else" } },
  ]) {
    const project = await temporaryProject("adaptive foreign local marketplace ");
    try {
      const fake = await fakeCodex(project, {
        marketplaces: [{ name: "adaptive-model-router", ...entry }],
      });
      const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
      assert.equal(result.status, 4);
      assert.deepEqual((await state(fake)).mutations, []);
    } finally { await project.cleanup(); }
  }
});

test("upgrade accepts a stable marketplace checkout when Codex omits install metadata", async () => {
  const project = await temporaryProject("adaptive marketplace checkout Unicode 空格 ");
  try {
    const marketplaceRoot = join(project.root, "marketplace checkout 中文");
    await mkdir(join(marketplaceRoot, ".git"), { recursive: true });
    await writeFile(join(marketplaceRoot, ".git", "HEAD"), "ref: refs/heads/stable\n");
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [{
        pluginId: "adaptive-model-router@adaptive-model-router",
        name: "adaptive-model-router",
        marketplaceName: "adaptive-model-router",
      }],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin marketplace upgrade adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("upgrade rejects a non-stable marketplace checkout when Codex omits install metadata", async () => {
  const project = await temporaryProject();
  try {
    const marketplaceRoot = join(project.root, "marketplace-checkout");
    await mkdir(join(marketplaceRoot, ".git"), { recursive: true });
    await writeFile(join(marketplaceRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 4);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("upgrade rejects current Codex marketplace metadata for a different ref", async () => {
  const project = await temporaryProject();
  try {
    const marketplaceRoot = join(project.root, "marketplace-cache");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(join(marketplaceRoot, ".codex-marketplace-install.json"), JSON.stringify({
      source_type: "git",
      source: "https://github.com/Neil0619/adaptive-model-router.git",
      ref_name: "main",
      revision: "0123456789abcdef",
    }));
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 4);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("legacy adaptive-local stops noninteractive installation before mutation with exact cleanup commands", async () => {
  const project = await temporaryProject();
  try {
    const initial = {
      marketplaces: [{ name: "adaptive-local", marketplaceSource: { sourceType: "local", source: "/legacy" } }],
      installed: [{ pluginId: "adaptive-model-router@adaptive-local", name: "adaptive-model-router", marketplaceName: "adaptive-local" }],
      available: [],
      mutations: [],
    };
    const fake = await fakeCodex(project, initial);
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /codex plugin remove adaptive-model-router@adaptive-local/);
    assert.match(result.stderr, /codex plugin marketplace remove adaptive-local/);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("damaged modern state stops before confirmed legacy cleanup mutates registrations", async () => {
  const project = await temporaryProject("adaptive installer damaged modern with legacy ");
  try {
    const modernRoot = join(project.root, "plugins", "cache", "adaptive-model-router", "adaptive-model-router", runtimeVersion);
    const modern = {
      pluginId: "adaptive-model-router@adaptive-model-router",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-model-router",
      source: { source: "local", path: modernRoot },
    };
    const legacy = {
      pluginId: "adaptive-model-router@adaptive-local",
      name: "adaptive-model-router",
      marketplaceName: "adaptive-local",
      source: { source: "local", path: "/legacy" },
    };
    const fake = await fakeCodex(project, {
      pluginInstallRoot: modernRoot,
      mcpRegistered: false,
      marketplaces: [
        {
          name: "adaptive-model-router",
          marketplaceSource: {
            sourceType: "git",
            source: "https://github.com/Neil0619/adaptive-model-router.git",
            ref: "stable",
          },
        },
        { name: "adaptive-local", marketplaceSource: { sourceType: "local", source: "/legacy" } },
      ],
      installed: [modern, legacy],
      available: [modern],
    });

    const result = runManager(project, fake, ["install", "--yes", "--non-interactive"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /CACHE_DAMAGED/);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("explicit legacy migration removes old plugin then marketplace before installing the stable source", async () => {
  const project = await temporaryProject();
  try {
    const fake = await fakeCodex(project, {
      marketplaces: [{ name: "adaptive-local", marketplaceSource: { sourceType: "local", source: "/legacy" } }],
      installed: [{ pluginId: "adaptive-model-router@adaptive-local", name: "adaptive-model-router", marketplaceName: "adaptive-local" }],
      available: [], mutations: [],
    });
    const result = runManager(project, fake, ["install", "--yes"]);
    assert.equal(result.status, 0, result.stderr);
    const mutations = (await state(fake)).mutations.map((args) => args.join(" "));
    assert.deepEqual(mutations.slice(0, 4), [
      "plugin remove adaptive-model-router@adaptive-local",
      "plugin marketplace remove adaptive-local",
      "plugin marketplace add Neil0619/adaptive-model-router --ref stable",
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("an explicit release-candidate ref is required consistently for install, upgrade, and uninstall", async () => {
  const project = await temporaryProject();
  try {
    const candidateRef = "codex/v030-smoke-handoff";
    const fake = await fakeCodex(project);
    const invalid = runManager(project, fake, ["install", "--ref=../untrusted", "--non-interactive"]);
    assert.equal(invalid.status, 2);
    assert.deepEqual((await state(fake)).mutations, []);

    const installed = runManager(project, fake, ["install", `--ref=${candidateRef}`, "--non-interactive"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual((await state(fake)).mutations.slice(0, 2).map((args) => args.join(" ")), [
      `plugin marketplace add Neil0619/adaptive-model-router --ref ${candidateRef}`,
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);

    const wrongUpgrade = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(wrongUpgrade.status, 4);
    const upgraded = runManager(project, fake, ["upgrade", `--ref=${candidateRef}`, "--non-interactive"]);
    assert.equal(upgraded.status, 0, upgraded.stderr);

    const wrongUninstall = runManager(project, fake, ["uninstall", "--non-interactive"]);
    assert.equal(wrongUninstall.status, 4);
    const removed = runManager(project, fake, ["uninstall", `--ref=${candidateRef}`, "--non-interactive"]);
    assert.equal(removed.status, 0, removed.stderr);
  } finally {
    await project.cleanup();
  }
});

test("same marketplace name from another source and partial AGENTS markers fail before mutation", async () => {
  const project = await temporaryProject();
  try {
    const conflict = await fakeCodex(project, {
      marketplaces: [{ name: "adaptive-model-router", marketplaceSource: { sourceType: "git", source: "someone/else", ref: "stable" } }],
      installed: [], available: [], mutations: [],
    });
    const sourceFailure = runManager(project, conflict, ["install", "--non-interactive"]);
    assert.equal(sourceFailure.status, 4);
    assert.deepEqual((await state(conflict)).mutations, []);

    const clean = await fakeCodex(project);
    const codexHome = join(project.root, "Codex Home 空格");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "AGENTS.md"), `${AGENTS_MARKER_START}\npartial\n`);
    const markerFailure = runManager(project, clean, ["install", "--patch-agents", "--non-interactive"]);
    assert.equal(markerFailure.status, 6);
    assert.deepEqual((await state(clean)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("platform wrapper performs the same native installation flow", async () => {
  const project = await temporaryProject();
  try {
    const fake = await fakeCodex(project);
    const codexHome = join(project.root, "wrapper home 空格");
    const candidateRef = "codex/v030-smoke-handoff";
    let result;
    if (process.platform === "win32") {
      result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repoRoot, "install.ps1"), "-NonInteractive", "-Ref", candidateRef], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fake.bin};${dirname(process.execPath)};${process.env.PATH}`,
          CODEX_BIN: fake.executable, CODEX_HOME: codexHome, FAKE_CODEX_STATE: fake.statePath },
      });
    } else {
      result = spawnSync("sh", [join(repoRoot, "install.sh"), `--ref=${candidateRef}`, "--non-interactive"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fake.bin}:${dirname(process.execPath)}:${process.env.PATH}`, CODEX_HOME: codexHome, FAKE_CODEX_STATE: fake.statePath },
      });
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await state(fake)).installed.length, 1);
    assert.equal((await state(fake)).marketplaces[0].marketplaceSource.ref, candidateRef);
  } finally {
    await project.cleanup();
  }
});
