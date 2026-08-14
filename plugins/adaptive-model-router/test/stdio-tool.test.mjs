import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(pluginRoot, "scripts", "stdio-tool.mjs");

test("stdio bridge calls the installed route_stage contract for a frozen task inventory", async () => {
  const home = await mkdtemp(join(tmpdir(), "adaptive-router-stdio-test-"));
  try {
    const result = spawnSync(process.execPath, [bridge], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ADAPTIVE_ROUTER_HOME: home,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: JSON.stringify({
        name: "route_stage",
        arguments: {
          goal: "verify frozen task inventory bridge",
          phase: "verification",
          evidence: {
            workProduct: false,
            requirementsSettled: true,
            strongVerification: true,
            hostCanDelegate: false,
          },
          contextId: "frozen-task-bridge-test",
        },
      }),
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.transport, "stdio-bridge");
    assert.equal(output.tool, "route_stage");
    assert.equal(output.isError, false);
    assert.equal(output.structuredContent.action, "continue");
    assert.deepEqual(output.structuredContent.reasonCodes, ["HOST_DELEGATION_UNAVAILABLE"]);
    assert.equal(typeof output.structuredContent.routeId, "string");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stdio bridge rejects tools not auto-approved by the installed MCP contract", () => {
  const result = spawnSync(process.execPath, [bridge], {
    cwd: pluginRoot,
    encoding: "utf8",
    input: JSON.stringify({
      name: "configure_router",
      arguments: { contextId: "rejected", enabled: true },
    }),
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not approved by the installed MCP contract/i);
});

test("stdio bridge processes one JSON line without waiting for stdin to close", async () => {
  const home = await mkdtemp(join(tmpdir(), "adaptive-router-stdio-line-test-"));
  try {
    const output = await new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, [bridge], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          ADAPTIVE_ROUTER_HOME: home,
          ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("stdio bridge waited for EOF"));
      }, 5_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolveOutput(stdout);
        else reject(new Error(stderr || `bridge exited ${code}`));
      });
      child.stdin.write(`${JSON.stringify({
        name: "get_route_status",
        arguments: { contextId: "open-stdin-line-test" },
      })}\n`);
    });
    const result = JSON.parse(output);
    assert.equal(result.transport, "stdio-bridge");
    assert.equal(result.isError, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("source-checkout bridge shares the installed plugin data directory with Hooks and MCP", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "adaptive-router-stdio-home-"));
  const pluginData = join(
    codexHome,
    "plugins",
    "data",
    "adaptive-model-router-adaptive-model-router",
  );
  try {
    const result = spawnSync(process.execPath, [bridge], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        CODEX_HOME: codexHome,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      input: JSON.stringify({
        name: "get_route_status",
        arguments: { contextId: "source-checkout-installed-data-test" },
      }),
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).isError, false);
    await access(join(pluginData, "router.sqlite3"));
    await assert.rejects(access(join(codexHome, "adaptive-model-router-v2", "router.sqlite3")), {
      code: "ENOENT",
    });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
