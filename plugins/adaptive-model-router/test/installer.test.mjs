import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";
import { createHash } from "node:crypto";
import { AGENTS_MARKER_START, AGENTS_MARKER_END } from "../scripts/lib/constants.mjs";
import { captureRuntimeHostEntries, restoreRuntimeHostEntries } from "../scripts/lib/runtime-host-retention.mjs";
import { prepareRuntimeHostEntry } from "../scripts/lib/runtime-host-entry.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fakeCodex(project, script) {
  const bin = join(project.root, "bin");
  mkdirSync(bin);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "fake-codex.mjs"), script);
    const executable = join(bin, "codex.cmd");
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`);
    return executable;
  }
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!${process.execPath}\n${script}`);
  chmodSync(executable, 0o755);
  return executable;
}

test("cold host retention preserves all historical paths, rejects tampering/redirection, and never overwrites a new generation", async () => {
  const project = await temporaryProject("router-host-retention-");
  try {
    const versions = join(project.root, "versions"), anchor = join(versions, "old-a");
    cpSync(source, anchor, { recursive: true }); cpSync(source, join(versions, "old-b"), { recursive: true });
    const archive = join(project.root, "retained"), capture = captureRuntimeHostEntries(anchor, archive);
    rmSync(versions, { recursive: true }); mkdirSync(join(versions, "new"), { recursive: true }); writeFileSync(join(versions, "new/untouched"), "new-runtime");
    const restored = restoreRuntimeHostEntries(archive, versions);
    assert.equal(restored.files, capture.files); assert.equal(restored.restored, capture.files);
    assert.equal(restoreRuntimeHostEntries(archive, versions).restored, 0);
    assert.equal(readFileSync(join(versions, "new/untouched"), "utf8"), "new-runtime");
    writeFileSync(join(anchor, "runtime.json"), "changed");
    assert.throws(() => restoreRuntimeHostEntries(archive, versions), /conflicts/);
    rmSync(versions, { recursive: true }); const redirect = join(project.root, "redirect"); mkdirSync(redirect); symlinkSync(redirect, versions, "dir");
    assert.throws(() => restoreRuntimeHostEntries(archive, versions), /path or full content/);
    assert.deepEqual(readdirSync(redirect), []);
  } finally { await project.cleanup(); }
});

test("host retention rejects its source and nested destinations before mutation while allowing a sibling", async () => {
  const project = await temporaryProject("router-host-retention-containment-");
  try {
    const versions = join(project.root, "versions"), anchor = join(versions, "installed");
    mkdirSync(join(anchor, ".codex-plugin"), { recursive: true });
    const files = [
      [join(anchor, ".codex-plugin", "plugin.json"), readFileSync(join(source, ".codex-plugin", "plugin.json"), "utf8")],
      [join(anchor, "runtime.json"), readFileSync(join(source, "runtime.json"), "utf8")],
      [join(versions, "legacy-index.json"), "retained legacy index"],
    ];
    for (const [path, content] of files) writeFileSync(path, content);
    const before = readdirSync(versions, { recursive: true }).sort();
    const nested = join(versions, "nested", "retained");
    for (const destination of [versions, nested]) {
      assert.throws(() => captureRuntimeHostEntries(anchor, destination), /Host retention must be outside native caches/);
      assert.equal(existsSync(join(versions, "nested")), false, "rejection must precede even parent directory creation");
      assert.deepEqual(readdirSync(versions, { recursive: true }).sort(), before);
      for (const [path, content] of files) assert.equal(readFileSync(path, "utf8"), content);
    }
    const sibling = join(project.root, "versions-retained");
    const captured = captureRuntimeHostEntries(anchor, sibling);
    assert.equal(captured.files, files.length);
    assert.equal(readFileSync(join(sibling, "tree", "legacy-index.json"), "utf8"), "retained legacy index");
    assert.deepEqual(readdirSync(versions, { recursive: true }).sort(), before);
  } finally { await project.cleanup(); }
});

test("native CLI first registration replaces the isolated marketplace and restores every legacy cache path", {
  skip: !(process.env.ADAPTIVE_ROUTER_NATIVE_CLI && process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE) && "Requires explicit native CLI and exact isolated v1 fixture",
}, async () => {
  const project = await temporaryProject("router-native-registration-");
  try {
    const codexHome = join(project.root, "codex"), oldMarket = join(project.root, "old-market"); mkdirSync(codexHome);
    cpSync(process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE, join(oldMarket, "plugin"), { recursive: true });
    mkdirSync(join(oldMarket, ".agents/plugins"), { recursive: true });
    writeFileSync(join(oldMarket, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "adaptive-model-router", interface: { displayName: "Adaptive Model Router" },
      plugins: [{ name: "adaptive-model-router", source: { source: "local", path: "./plugin" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] }));
    const env = { ...process.env, CODEX_HOME: codexHome, ADAPTIVE_ROUTER_HOME: project.home, PLUGIN_DATA: project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" };
    const cli = (...args) => {
      const result = spawnSync(process.env.ADAPTIVE_ROUTER_NATIVE_CLI, args, { cwd: project.root, env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    cli("plugin", "marketplace", "add", oldMarket, "--json");
    const old = cli("plugin", "add", "adaptive-model-router@adaptive-model-router", "--json");
    const oldRoot = old.installedPath, versions = dirname(oldRoot);
    cpSync(oldRoot, join(versions, "0.4.0+codex.20000101000000"), { recursive: true });
    const retained = captureRuntimeHostEntries(oldRoot, join(project.root, "retained"));
    const shell = prepareRuntimeHostEntry(source, join(project.root, "entry/plugin"), project.home);
    cli("plugin", "marketplace", "remove", "adaptive-model-router", "--json");
    cli("plugin", "marketplace", "add", shell.marketplace, "--json");
    const next = cli("plugin", "add", "adaptive-model-router@adaptive-model-router", "--json");
    assert.notEqual(next.installedPath, oldRoot); assert.match(next.version, /\.runtime2$/);
    const restore = restoreRuntimeHostEntries(retained.archive, versions);
    assert.equal(restore.files, retained.files); assert.equal(restoreRuntimeHostEntries(retained.archive, versions).restored, 0);
    const registered = cli("plugin", "list", "--json").installed;
    assert.equal(registered.length, 1); assert.equal(registered[0].enabled, true); assert.equal(registered[0].version, next.version);
    const config = JSON.parse(readFileSync(join(next.installedPath, ".mcp.json"), "utf8")).mcpServers["adaptive-model-router"];
    assert.equal(config.cwd, shell.root); assert.equal(config.args[0], join(shell.root, "scripts/node-launcher.mjs"));
    assert.equal(existsSync(project.home), false, "native registration does not execute Router code or initialize another data domain");
    mkdirSync(project.home); const retainedData = join(project.home, "retained-learning"); writeFileSync(retainedData, "original data");
    const uninstall = spawnSync(process.execPath, [join(shell.root, "scripts/manage-install.mjs"), "uninstall", "--non-interactive"], {
      cwd: project.root, env: { ...env, CODEX_BIN: process.env.ADAPTIVE_ROUTER_NATIVE_CLI,
        ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR: join(project.root, "isolated-override") }, encoding: "utf8", timeout: 30_000 });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.deepEqual(cli("plugin", "list", "--json").installed, []);
    assert.equal(cli("plugin", "marketplace", "list", "--json").marketplaces.some((entry) => entry.name === "adaptive-model-router"), false);
    assert.equal(readFileSync(retainedData, "utf8"), "original data");
  } finally { await project.cleanup(); }
});

test("v2 install, upgrade and repair refuse legacy hot mutations before opening global state or invoking Codex", async () => {
  const project = await temporaryProject("router-v2-install-guard-");
  try {
    for (const action of ["install", "upgrade", "repair"]) {
      const result = spawnSync(process.execPath, [join(source, "scripts/manage-install.mjs"), action, "--non-interactive", "--refresh-host-surface"], {
        encoding: "utf8", env: { ...process.env, CODEX_HOME: project.home, CODEX_BIN: join(project.root, "must-not-run") } });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Protocol v2 refuses legacy hot-install/);
      assert.equal(existsSync(project.home), false, "refusal precedes config/database/cache mutation");
    }
  } finally { await project.cleanup(); }
});

test("direct writer verification fails before opening any writer when isolation env is missing, inconsistent or redirected", () => {
  const root = mkdtempSync(join(tmpdir(), "router-writer-qualification-"));
  try {
    const isolated = { ADAPTIVE_ROUTER_HOME: join(root, "state"), PLUGIN_DATA: join(root, "state"), CODEX_HOME: join(root, "codex"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1" };
    for (const change of [{}, { ...isolated, CODEX_HOME: join(root, "wrong") }, { ...isolated, ADAPTIVE_ROUTER_HOME: join(homedir(), ".codex/adaptive-model-router-v2") }]) {
      const env = { ...process.env }; for (const key of Object.keys(isolated)) delete env[key]; Object.assign(env, change);
      const result = spawnSync(process.execPath, [join(source, "scripts/verify-runtime-compatibility.mjs"), "must-not-import", "must-not-import", root], { encoding: "utf8", env });
      assert.equal(result.status, 2); assert.match(result.stderr, /no writer was opened/); assert.deepEqual(readdirSync(root), []);
    }
    const other = mkdtempSync(join(tmpdir(), "router-isolation-redirect-"));
    try {
      symlinkSync(other, join(root, "state"), "dir");
      const result = spawnSync(process.execPath, [join(source, "scripts/verify-runtime-compatibility.mjs"), "must-not-import", "must-not-import", root], { encoding: "utf8", env: { ...process.env, ...isolated } });
      assert.equal(result.status, 2); assert.deepEqual(readdirSync(other), []);
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI rejects a live-host legacy bootstrap, bad input and unregistered references before changing legacy rows or schema", {
  skip: !process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE && "Requires the exact isolated installed-v1 fixture",
}, async () => {
  const project = await temporaryProject("router-cli-cold-refusal-");
  let child;
  try {
    await withRouterEnvironment(project, async () => {
      const legacy = join(project.root, "legacy-copy"); cpSync(process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE, legacy, { recursive: true });
      const { RouterStore } = await import(pathToFileURL(join(legacy, "scripts/lib/database.mjs")));
      const store = new RouterStore(); const context = store.context({ cwd: project.root, contextId: "retained-legacy" });
      store.configure(context, { autoActivate: true }, "global"); store.close();
      const database = join(project.home, "router.sqlite3");
      const before = createHash("sha256").update(readFileSync(database)).digest("hex");
      const beforeFiles = readdirSync(project.home).sort();
      child = spawn(process.execPath, ["-e", "process.title='codex'; process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      await new Promise((done) => child.stdout.once("data", done));
      for (const args of [
        ["bootstrap", `--candidate=${source}`, `--shell-root=${source}`, `--home=${project.home}`, `--legacy-runtime=${legacy}`],
        ["unknown-action", `--home=${project.home}`],
        ["bootstrap", `--candidate=${join(project.root, "missing")}`, `--shell-root=${source}`, `--home=${project.home}`],
        ["references", "--digest=unregistered", `--home=${project.home}`],
      ]) {
        const result = spawnSync(process.execPath, [join(source, "scripts/runtime-admin.mjs"), ...args], { encoding: "utf8", env: process.env });
        assert.equal(result.status, 2, result.stdout); assert.equal(createHash("sha256").update(readFileSync(database)).digest("hex"), before, result.stderr);
        assert.deepEqual(readdirSync(project.home).sort(), beforeFiles, "refusal did not create packages or SQLite companions");
      }
    });
  } finally { if (child && child.exitCode === null) { child.kill(); await new Promise((done) => child.once("exit", done)); } await project.cleanup(); }
});

test("prepared stable Hook and MCP entries execute from a registered cache while retaining the explicit original shared home", async () => {
  const project = await temporaryProject("router-stable-entry-中文-");
  try {
    const shell = join(project.root, "stable-shell");
    const cli = (args) => {
      const result = spawnSync(process.execPath, [join(source, "scripts/runtime-admin.mjs"), ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: join(project.root, "codex") } });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    const prepared = cli(["prepare-shell", `--source=${source}`, `--shell-root=${shell}`, `--home=${project.home}`]);
    assert.equal(prepared.registered, false); assert.equal(existsSync(project.home), false);
    cli(["bootstrap", `--candidate=${shell}`, `--shell-root=${shell}`, `--home=${project.home}`]);
    const cache = join(project.root, "native-cache"); cpSync(shell, cache, { recursive: true });
    const env = { ...process.env, CODEX_HOME: join(project.root, "codex"), PLUGIN_ROOT: cache, PLUGIN_DATA: join(project.root, "unused-native-plugin-data"),
      ADAPTIVE_ROUTER_LOCAL_ONLY: "1", CODEX_THREAD_ID: "entry-owner" }; delete env.ADAPTIVE_ROUTER_HOME;
    const hook = spawnSync(process.execPath, [join(shell, "scripts/node-launcher.mjs"), join(shell, "scripts/hook.mjs"), "prompt"], { cwd: project.root, env, encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "entry-owner", cwd: project.root, turn_id: "n", model: "gpt-6-astra", prompt: "router: global on" }) });
    assert.equal(hook.status, 0, hook.stderr);
    const config = JSON.parse(readFileSync(join(cache, ".mcp.json"), "utf8")).mcpServers["adaptive-model-router"];
    const mcp = spawnSync(config.command, config.args, { cwd: config.cwd, env, encoding: "utf8",
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_route_status", arguments: { contextId: "entry-owner" } } }) + "\n" });
    assert.equal(mcp.status, 0, mcp.stderr); assert.equal(JSON.parse(mcp.stdout).result.isError, false, mcp.stdout);
    assert.equal(JSON.parse(mcp.stdout).result.structuredContent.autoActivation.globalEnabled, true);
    assert.equal(existsSync(env.PLUGIN_DATA), false, "new plugin registration must not create a second quota/policy domain");
    assert.equal(JSON.parse(readFileSync(join(prepared.marketplace, ".agents/plugins/marketplace.json"), "utf8")).plugins[0].source.path, "./stable-shell");
  } finally { await project.cleanup(); }
});

test("deferred uninstall preserves shared learning and unrelated config while removing only the owned AGENTS block", async () => {
  const project = await temporaryProject("router-uninstall-v2-");
  try {
    const codexHome = join(project.root, "codex"); mkdirSync(codexHome);
    const original = "User-owned instructions.\n", agents = join(codexHome, "AGENTS.md");
    writeFileSync(agents, original + "\n" + AGENTS_MARKER_START + "\n<!-- adaptive-model-router:restore separator=1 created=0 -->\nOwned block\n" + AGENTS_MARKER_END + "\n");
    const config = join(codexHome, "config.toml"); writeFileSync(config, 'model = "gpt-6-astra"\n');
    const data = join(project.root, "learning.sqlite3"); writeFileSync(data, "retained learning fixture");
    const fake = fakeCodex(project, `const a=process.argv.slice(2).join(' '); if(a==='--version')console.log('codex 0.153.4'); else if(a==='plugin marketplace list --json')console.log('{"marketplaces":[]}'); else if(a==='plugin list --available --json')console.log('{"installed":[],"available":[]}'); else if(a==='mcp list --json')console.log('[]'); else process.exit(9);\n`);
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [join(source, "scripts/manage-install.mjs"), "uninstall", "--non-interactive"], { encoding: "utf8", env: { ...process.env,
        CODEX_HOME: codexHome, CODEX_BIN: fake, ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR: join(project.root, "isolated-override") } });
      assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(agents, "utf8"), original);
      assert.equal(readFileSync(config, "utf8"), 'model = "gpt-6-astra"\n'); assert.equal(readFileSync(data, "utf8"), "retained learning fixture");
    }
  } finally { await project.cleanup(); }
});

test("explicit uninstall recognizes the prepared stable marketplace from source, shell and cache, and refuses a foreign owner", async () => {
  const project = await temporaryProject("router-stable-uninstall-");
  try {
    const codexHome = join(project.root, "codex"); mkdirSync(codexHome);
    const shell = prepareRuntimeHostEntry(source, join(project.root, "entry/plugin"), project.home);
    const cache = join(project.root, "cache-copy"); cpSync(shell.root, cache, { recursive: true });
    const config = join(codexHome, "config.toml"); writeFileSync(config, 'model = "gpt-6-astra"\n');
    mkdirSync(project.home); const data = join(project.home, "retained-learning"); writeFileSync(data, "original data");
    const state = join(project.root, "native-state.json"), calls = join(project.root, "native-removals.jsonl");
    const fakePath = fakeCodex(project, `import {readFileSync,appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2).join(' '), state=JSON.parse(readFileSync(${JSON.stringify(state)},'utf8'));\nif(a==='--version')console.log('codex 0.153.4');\nelse if(a==='plugin marketplace list --json')console.log(JSON.stringify({marketplaces:[{name:'adaptive-model-router',root:state.marketplace}]}));\nelse if(a==='plugin list --available --json')console.log(JSON.stringify({installed:[{pluginId:'adaptive-model-router@adaptive-model-router'}],available:[]}));\nelse if(a==='mcp list --json')console.log('[]');\nelse if(['plugin remove adaptive-model-router@adaptive-model-router','plugin marketplace remove adaptive-model-router'].includes(a)){appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');console.log('{}');}\nelse process.exit(9);\n`);
    const run = (root, marketplace, status) => {
      writeFileSync(state, JSON.stringify({ marketplace })); writeFileSync(calls, "");
      const result = spawnSync(process.execPath, [join(root, "scripts/manage-install.mjs"), "uninstall", "--non-interactive"], { encoding: "utf8", env: { ...process.env,
        CODEX_HOME: codexHome, CODEX_BIN: fakePath, PLUGIN_DATA: project.home, ADAPTIVE_ROUTER_HOME: project.home,
        ADAPTIVE_ROUTER_DESKTOP_OVERRIDE_DIR: join(project.root, "isolated-override") } });
      assert.equal(result.status, status, result.stderr);
      const removed = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.deepEqual(removed, status === 0 ? ["plugin remove adaptive-model-router@adaptive-model-router", "plugin marketplace remove adaptive-model-router"] : []);
      assert.equal(readFileSync(config, "utf8"), 'model = "gpt-6-astra"\n'); assert.equal(readFileSync(data, "utf8"), "original data");
      return result;
    };
    for (const root of [source, shell.root, cache]) run(root, shell.marketplace, 0);
    const otherSource = join(project.root, "other-source"); cpSync(source, otherSource, { recursive: true });
    const foreign = prepareRuntimeHostEntry(otherSource, join(project.root, "foreign/plugin"), project.home);
    assert.match(run(source, foreign.marketplace, 4).stderr, /different source/);
    const manifestPath = join(shell.marketplace, ".agents/plugins/marketplace.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.plugins.push({ name: "unrelated-plugin" });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(run(cache, shell.marketplace, 4).stderr, /different source/);
  } finally { await project.cleanup(); }
});

test("runtime-admin executes prepare, empty-home bootstrap, explicit code publication and protected archival end to end", async () => {
  const project = await temporaryProject("router-v2-admin-中文-");
  try {
    const shell = join(project.root, "entry/stable-shell"); prepareRuntimeHostEntry(source, shell, project.home);
    const cli = (args, status = 0) => {
      const result = spawnSync(process.execPath, [join(shell, "scripts/runtime-admin.mjs"), ...args], {
        encoding: "utf8", env: { ...process.env, CODEX_HOME: join(project.root, "codex"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1" }, timeout: 55_000 });
      assert.equal(result.status, status, result.stderr);
      return status === 0 ? JSON.parse(result.stdout) : result;
    };
    const a = cli(["prepare", `--source=${shell}`, `--candidates=${join(project.root, "offline")}`]);
    assert.equal(a.productionChanged, false); assert.equal(existsSync(project.home), false);
    cli(["bootstrap", `--candidate=${a.candidate}`, `--home=${project.home}`, `--shell-root=${shell}`]);
    assert.equal(existsSync(join(project.home, "runtime/active.json")), false);
    const bSource = join(project.root, "development-b"); cpSync(source, bSource, { recursive: true });
    const scorer = join(bSource, "scripts/lib/scorer.mjs"); writeFileSync(scorer, readFileSync(scorer, "utf8").replace('  if (includesAny(text, PATTERNS.review))', '  if (text.includes("glossary")) return "documentation";\n  if (includesAny(text, PATTERNS.review))'));
    for (const relative of ["runtime.json", ".codex-plugin/plugin.json"]) {
      const path = join(bSource, relative), data = JSON.parse(readFileSync(path, "utf8"));
      data[relative === "runtime.json" ? "runtimeVersion" : "version"] = "0.4.0+admin.b"; writeFileSync(path, JSON.stringify(data));
    }
    const b = cli(["prepare", `--source=${bSource}`, `--shell-root=${shell}`, `--candidates=${join(project.root, "offline")}`]);
    cli(["publish", `--candidate=${b.candidate}`, `--home=${project.home}`]);
    const sourceHooks = join(bSource, "hooks/hooks.json"); writeFileSync(sourceHooks, readFileSync(sourceHooks, "utf8") + "\n");
    assert.match(cli(["prepare", `--source=${bSource}`, `--shell-root=${shell}`, `--candidates=${join(project.root, "refused-offline")}`], 2).stderr, /frozen native entry/);
    assert.equal(existsSync(join(project.root, "refused-offline")), false);
    const refs = cli(["references", `--digest=${a.digest}`, `--home=${project.home}`]);
    assert.ok(refs.includes("host_entry") && refs.includes("rollback"));
    assert.match(cli(["archive", `--digest=${a.digest}`, `--home=${project.home}`], 2).stderr, /referenced/);
    cli(["publish", `--candidate=${a.candidate}`, `--home=${project.home}`]);
    assert.equal(existsSync(join(project.home, "runtime/active.json")), false, "rollback is an explicit default publication; legacy pointers remain intact");
  } finally { await project.cleanup(); }
});
