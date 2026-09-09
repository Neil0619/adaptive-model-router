import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compareRuntimeVersions,
  parseRuntimeDescriptor,
  resolveRuntime,
  runtimePublicState,
} from "../scripts/lib/runtime-loader.mjs";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function createRuntime(
  root,
  version,
  { hookMarker = null, brokenProbe = false, exclusiveProbe = false } = {},
) {
  await cp(pluginRoot, root, { recursive: true });
  const descriptorPath = join(root, "runtime.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  descriptor.runtimeVersion = version;
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const constantsPath = join(root, "scripts", "lib", "constants.mjs");
  const constants = await readFile(constantsPath, "utf8");
  await writeFile(
    constantsPath,
    constants.replace(/export const ROUTER_VERSION = "[^"]+";/, `export const ROUTER_VERSION = "${version}";`),
  );
  if (hookMarker) {
    const hookPath = join(root, "scripts", "hook.mjs");
    const hook = await readFile(hookPath, "utf8");
    await writeFile(
      hookPath,
      hook.replace(
        /^#!\/usr\/bin\/env node\r?\n/u,
        `#!/usr/bin/env node\nprocess.stderr.write("${hookMarker}\\n");\n`,
      ),
    );
  }
  if (brokenProbe) {
    await writeFile(join(root, "scripts", "runtime-probe.mjs"), "#!/usr/bin/env node\nprocess.exit(78);\n");
  } else if (exclusiveProbe) {
    const marker = join(root, ".exclusive-probe.lock");
    const probePath = join(root, "scripts", "runtime-probe.mjs");
    const probe = await readFile(probePath, "utf8");
    await writeFile(
      probePath,
      probe.replace(
        /^#!\/usr\/bin\/env node\r?\n/u,
        `#!/usr/bin/env node
import {
  closeSync as closeExclusiveProbe,
  openSync as openExclusiveProbe,
  unlinkSync as unlinkExclusiveProbe,
} from "node:fs";
const exclusiveProbeMarker = ${JSON.stringify(marker)};
let exclusiveProbeDescriptor;
try {
  exclusiveProbeDescriptor = openExclusiveProbe(exclusiveProbeMarker, "wx");
} catch {
  process.exit(78);
}
try {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
} finally {
  closeExclusiveProbe(exclusiveProbeDescriptor);
  unlinkExclusiveProbe(exclusiveProbeMarker);
}
`,
      ),
    );
  }
}

function jsonRpcProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiters = [];
  const queued = [];
  output.on("line", (line) => {
    const value = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  });
  child.on("error", (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  return {
    child,
    async send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      if (queued.length) return queued.shift();
      return await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function runProcess(command, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("runtime descriptors and cachebuster versions are strict and monotonic", () => {
  assert.ok(compareRuntimeVersions("0.4.1", "0.4.0+codex.local-20260724-120000") > 0);
  assert.ok(
    compareRuntimeVersions(
      "0.4.0+codex.local-20260724-120001",
      "0.4.0+codex.local-20260724-120000",
    ) > 0,
  );
  assert.throws(
    () => parseRuntimeDescriptor({
      schemaVersion: 1,
      runtimeVersion: "0.4.0",
      shellProtocolVersion: 1,
      toolContractVersion: 3,
      storageContractVersion: 1,
      databaseVersion: 3,
      entrypoints: {
        hook: "../hook.mjs",
        service: "scripts/lib/service.mjs",
        probe: "scripts/runtime-probe.mjs",
      },
    }),
    /entrypoint is invalid/,
  );
});

test("runtime diagnostics ignore an active pointer whose immutable directory is absent", async () => {
  const project = await temporaryProject("adaptive stale active pointer ");
  const currentRoot = join(project.root, "versions", "0.4.1");
  const pluginData = join(project.root, "plugin-data");
  try {
    await createRuntime(currentRoot, "0.4.1");
    await mkdir(join(pluginData, "runtime"), { recursive: true });
    await writeFile(join(pluginData, "runtime", "active.json"), `${JSON.stringify({
      schemaVersion: 1,
      activeDirectory: "0.4.0",
      activeVersion: "0.4.0",
      previousDirectory: null,
      previousVersion: null,
      failedDirectories: [],
    })}\n`);
    const env = { ...process.env, ADAPTIVE_ROUTER_HOME: pluginData };
    const resolution = resolveRuntime(currentRoot, { env, allowTrial: false });
    assert.equal(resolution.active.descriptor.runtimeVersion, "0.4.1");
    assert.equal(runtimePublicState(resolution, env).activeVersion, "0.4.1");
  } finally {
    await project.cleanup();
  }
});

test("quarantine wins over a later success for the same immutable cache directory", async () => {
  const project = await temporaryProject("adaptive quarantine precedence ");
  const versionsRoot = join(project.root, "versions");
  const version040 = join(versionsRoot, "0.4.0");
  const version041 = join(versionsRoot, "0.4.1");
  const pluginData = join(project.root, "plugin-data");
  await mkdir(versionsRoot, { recursive: true });
  await createRuntime(version040, "0.4.0");
  await createRuntime(version041, "0.4.1");
  const env = { ...process.env, ADAPTIVE_ROUTER_HOME: pluginData };
  try {
    const loader = await import(
      `${pathToFileURL(join(version040, "scripts", "lib", "runtime-loader.mjs")).href}?test=${Date.now()}`,
    );
    const trial = loader.resolveRuntime(version040, { env });
    assert.equal(trial.candidate.descriptor.runtimeVersion, "0.4.1");
    loader.markRuntimeFailed(trial, env);
    loader.markRuntimeHealthy(trial, env);
    const selected = loader.resolveRuntime(version040, { env, allowTrial: false });
    assert.equal(selected.candidate.descriptor.runtimeVersion, "0.4.0");
    assert.ok(selected.pointer.failedDirectories.includes("0.4.1"));
  } finally {
    await project.cleanup();
  }
});

test("a frozen strict MCP shell survives the reviewed sender-evidence extension without quarantining the runtime", { timeout: 60000 }, async () => {
  const project = await temporaryProject("adaptive frozen MCP contract ");
  const versionsRoot = join(project.root, "versions");
  const oldRoot = join(versionsRoot, "0.4.1");
  const nextRoot = join(versionsRoot, "0.4.2");
  const pluginData = join(project.root, "plugin-data");
  await createRuntime(oldRoot, "0.4.1");
  const servicePath = join(oldRoot, "scripts", "lib", "service.mjs");
  const service = await readFile(servicePath, "utf8");
  assert.match(service, /        senderTranscriptPaths:/);
  await writeFile(servicePath, service.replace(/^        senderTranscriptPaths:.*\n/mu, ""));
  const serverPath = join(oldRoot, "scripts", "mcp-server.mjs");
  const sourceServer = await readFile(serverPath, "utf8");
  // This is the previously shipped in-memory comparator, not the new helper.
  const frozenServer = sourceServer.replace("{ sanitizedError, writeJsonLine }", "{ canonicalJson, sanitizedError, writeJsonLine }")
    .replace(/function contractMatches\(service\) \{[\s\S]*?\n\}/u, `const shellContract = canonicalJson(TOOL_DEFINITIONS.map(({ name, inputSchema }) => ({ name, inputSchema })));
function contractMatches(service) {
  return canonicalJson(service.TOOL_DEFINITIONS.map(({ name, inputSchema }) => ({ name, inputSchema }))) === shellContract;
}`);
  assert.notEqual(frozenServer, sourceServer);
  await writeFile(serverPath, frozenServer);
  const rpc = jsonRpcProcess(process.execPath, [serverPath], {
    cwd: oldRoot,
    env: { ...process.env, ADAPTIVE_ROUTER_HOME: pluginData, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
  });
  try {
    const initial = await rpc.send({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "diagnose_router", arguments: { contextId: "frozen-contract" } } });
    assert.equal(initial.result.structuredContent.runtime.runtimeVersion, "0.4.1");
    const inventory = await rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(inventory.result.tools.find((tool) => tool.name === "manage_stage").inputSchema.properties.senderTranscriptPaths, undefined);
    // Updating the bootstrap on disk does not replace the comparator already
    // executing in this process. The candidate must work with that comparator.
    await writeFile(serverPath, sourceServer);
    await createRuntime(nextRoot, "0.4.2");
    const upgraded = await rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "diagnose_router", arguments: { contextId: "frozen-contract" } } });
    assert.equal(upgraded.result.structuredContent.runtime.runtimeVersion, "0.4.2");
    const after = await rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.deepEqual(after.result.tools, inventory.result.tools, "the existing host inventory remains unchanged");
    const pointer = JSON.parse(await readFile(join(pluginData, "runtime", "active.json"), "utf8"));
    assert.equal(pointer.activeVersion, "0.4.2");
    assert.deepEqual(pointer.failedDirectories, []);
    const modern = await runProcess(process.execPath, [join(nextRoot, "scripts", "mcp-server.mjs")], {
      cwd: nextRoot,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: pluginData, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
    }, `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    assert.equal(modern.status, 0, modern.stderr);
    assert.equal(JSON.parse(modern.stdout).result.tools.find((tool) => tool.name === "manage_stage")
      .inputSchema.properties.senderTranscriptPaths.maxItems, 3, "fresh callers keep the complete current interface");

    const incompatibleRoot = join(versionsRoot, "0.4.3");
    await createRuntime(incompatibleRoot, "0.4.3");
    const incompatiblePath = join(incompatibleRoot, "scripts", "lib", "service.mjs");
    const incompatible = await readFile(incompatiblePath, "utf8");
    const changed = incompatible.replace('required: ["contextId", "routeId", "action", "expectedRevision"]',
      'required: ["contextId", "routeId", "action", "expectedRevision", "senderTranscriptPaths"]');
    assert.notEqual(changed, incompatible);
    await writeFile(incompatiblePath, changed);
    const denied = await rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "diagnose_router", arguments: { contextId: "frozen-contract" } } });
    assert.equal(denied.result.structuredContent.runtime.runtimeVersion, "0.4.2", "an unreviewed mandatory input still cannot activate");
    const rejected = JSON.parse(await readFile(join(pluginData, "runtime", "active.json"), "utf8"));
    assert.deepEqual(rejected.failedDirectories, ["0.4.3"]);
  } finally {
    await rpc.close();
    await project.cleanup();
  }
});

test("an existing MCP process and hook shell activate a compatible installed runtime without restarting", async () => {
  const project = await temporaryProject("adaptive hot runtime 空格 ");
  const versionsRoot = join(project.root, "plugins", "cache", "market", "adaptive-model-router");
  const version040 = join(versionsRoot, "0.4.0");
  const version041 = join(versionsRoot, "0.4.1");
  const version042 = join(versionsRoot, "0.4.2");
  const pluginData = join(project.root, "plugins", "data", "market-adaptive-model-router");
  await mkdir(versionsRoot, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  await createRuntime(version040, "0.4.0");
  assert.match(await readFile(join(version040, "scripts", "node-launcher.mjs"), "utf8"), /runtime=pinned/);
  const env = {
    ...process.env,
    PLUGIN_ROOT: version040,
    PLUGIN_DATA: pluginData,
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
    ADAPTIVE_ROUTER_RUNTIME_TRACE: "1",
  };
  delete env.ADAPTIVE_ROUTER_HOME;
  const launcher = join(version040, "scripts", "node-launcher.mjs");
  const server = join(version040, "scripts", "mcp-server.mjs");
  const rpc = jsonRpcProcess(process.execPath, [launcher, server], {
    cwd: project.root,
    env,
    windowsHide: true,
  });
  try {
    const initialized = await rpc.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(initialized.result.serverInfo.version, "0.4.0");
    const first = await rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "diagnose_router", arguments: { contextId: "hot-runtime" } },
    });
    assert.equal(first.result.structuredContent.runtime.runtimeVersion, "0.4.0");

    await createRuntime(version041, "0.4.1", { hookMarker: "runtime-0.4.1" });
    assert.match(await readFile(join(version041, "scripts", "hook.mjs"), "utf8"), /runtime-0\.4\.1/);
    const upgraded = await rpc.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "diagnose_router", arguments: { contextId: "hot-runtime" } },
    });
    assert.equal(upgraded.result.structuredContent.runtime.runtimeVersion, "0.4.1");
    assert.equal(upgraded.result.structuredContent.routerVersion, "0.4.1");
    assert.equal(upgraded.result.structuredContent.runtime.hotReload, true);

    const oldHook = join(version040, "scripts", "hook.mjs");
    const copiedLoader = await import(
      `${pathToFileURL(join(version040, "scripts", "lib", "runtime-loader.mjs")).href}?test=${Date.now()}`,
    );
    const copiedResolution = copiedLoader.resolveRuntime(version040, { env });
    assert.equal(copiedResolution.current.root, version040);
    assert.equal(copiedLoader.runtimeEntrypoint(copiedResolution.current, "hook"), oldHook);
    const hook = spawnSync(process.execPath, [launcher, oldHook, "prompt"], {
      cwd: project.root,
      env,
      input: JSON.stringify({
        cwd: project.root,
        session_id: "hot-hook",
        model: "gpt-5.6-sol",
        prompt: "router: global on",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(hook.stderr, /runtime-0\.4\.1/);

    const compactHook = spawnSync(process.execPath, [launcher, oldHook, "session-start"], {
      cwd: project.root,
      env,
      input: JSON.stringify({
        cwd: project.root,
        session_id: "hot-hook",
        model: "gpt-5.6-sol",
        hook_event_name: "SessionStart",
        source: "compact",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(compactHook.status, 0, compactHook.stderr);
    assert.match(compactHook.stderr, /runtime-0\.4\.1/);
    const compactOutput = JSON.parse(compactHook.stdout).hookSpecificOutput;
    assert.equal(compactOutput.hookEventName, "SessionStart");
    assert.match(compactOutput.additionalContext, /Use "hot-hook" as the contextId/);

    await createRuntime(version042, "0.4.2", { brokenProbe: true });
    const rolledBackHook = spawnSync(process.execPath, [launcher, oldHook, "prompt"], {
      cwd: project.root,
      env,
      input: JSON.stringify({
        cwd: project.root,
        session_id: "hot-hook",
        model: "gpt-5.6-sol",
        prompt: "router: status",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(rolledBackHook.status, 0, rolledBackHook.stderr);
    assert.match(rolledBackHook.stderr, /runtime-0\.4\.1/);

    const pointerText = await readFile(join(pluginData, "runtime", "active.json"), "utf8");
    const pointer = JSON.parse(pointerText);
    assert.equal(pointer.activeVersion, "0.4.1");
    assert.ok(pointer.failedDirectories.includes("0.4.2"));
    assert.doesNotMatch(pointerText, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const afterRollback = await rpc.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "diagnose_router", arguments: { contextId: "hot-runtime" } },
    });
    assert.equal(afterRollback.result.structuredContent.runtime.runtimeVersion, "0.4.1");
    assert.equal(rpc.child.killed, false);
  } finally {
    await rpc.close();
    await project.cleanup();
  }
});

test("concurrent old hook shells activate one compatible runtime without corrupting the pointer", async () => {
  const project = await temporaryProject("adaptive concurrent runtime ");
  const versionsRoot = join(project.root, "plugins", "cache", "market", "adaptive-model-router");
  const version040 = join(versionsRoot, "0.4.0");
  const version041 = join(versionsRoot, "0.4.1");
  const pluginData = join(project.root, "plugins", "data", "market-adaptive-model-router");
  await mkdir(versionsRoot, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  await createRuntime(version040, "0.4.0", { exclusiveProbe: true });
  await createRuntime(version041, "0.4.1", { hookMarker: "runtime-0.4.1" });
  const env = {
    ...process.env,
    PLUGIN_ROOT: version040,
    PLUGIN_DATA: pluginData,
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
    ADAPTIVE_ROUTER_RUNTIME_TRACE: "1",
  };
  delete env.ADAPTIVE_ROUTER_HOME;
  const launcher = join(version040, "scripts", "node-launcher.mjs");
  const hook = join(version040, "scripts", "hook.mjs");
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => runProcess(
        process.execPath,
        [launcher, hook, "prompt"],
        { cwd: project.root, env, windowsHide: true },
        JSON.stringify({
          cwd: project.root,
          session_id: `concurrent-hot-${index}`,
          model: "gpt-5.6-sol",
          prompt: "router: status",
        }),
      )),
    );
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /runtime-0\.4\.1/);
    }
    const pointer = JSON.parse(
      await readFile(join(pluginData, "runtime", "active.json"), "utf8"),
    );
    assert.equal(pointer.activeVersion, "0.4.1");
    assert.deepEqual(pointer.failedDirectories, []);
  } finally {
    await project.cleanup();
  }
});

test("a previously activated runtime rolls back after its hook later fails", async () => {
  const project = await temporaryProject("adaptive active rollback ");
  const versionsRoot = join(project.root, "plugins", "cache", "market", "adaptive-model-router");
  const version040 = join(versionsRoot, "0.4.0");
  const version041 = join(versionsRoot, "0.4.1");
  const pluginData = join(project.root, "plugins", "data", "market-adaptive-model-router");
  await mkdir(versionsRoot, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  await createRuntime(version040, "0.4.0");
  await createRuntime(version041, "0.4.1", { hookMarker: "runtime-0.4.1" });
  const env = {
    ...process.env,
    PLUGIN_ROOT: version040,
    PLUGIN_DATA: pluginData,
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
    ADAPTIVE_ROUTER_RUNTIME_TRACE: "1",
  };
  delete env.ADAPTIVE_ROUTER_HOME;
  const launcher = join(version040, "scripts", "node-launcher.mjs");
  const oldHook = join(version040, "scripts", "hook.mjs");
  const input = JSON.stringify({
    cwd: project.root,
    session_id: "active-rollback",
    model: "gpt-5.6-sol",
    prompt: "router: status",
  });
  try {
    const activated = spawnSync(process.execPath, [launcher, oldHook, "prompt"], {
      cwd: project.root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(activated.status, 0, activated.stderr);
    assert.match(activated.stderr, /runtime-0\.4\.1/);

    await writeFile(
      join(version041, "scripts", "hook.mjs"),
      "#!/usr/bin/env node\nprocess.exit(7);\n",
    );
    const failed = spawnSync(process.execPath, [launcher, oldHook, "prompt"], {
      cwd: project.root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(failed.status, 7, failed.stderr);

    const pointer = JSON.parse(
      await readFile(join(pluginData, "runtime", "active.json"), "utf8"),
    );
    assert.equal(pointer.activeVersion, "0.4.0");
    assert.ok(pointer.failedDirectories.includes("0.4.1"));

    const recovered = spawnSync(process.execPath, [launcher, oldHook, "prompt"], {
      cwd: project.root,
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stderr, /runtime=0\.4\.0/);
  } finally {
    await project.cleanup();
  }
});
