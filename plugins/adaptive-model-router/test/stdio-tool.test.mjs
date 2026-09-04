import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("stdio bridge fails explicitly when an open stdin never supplies a request", async () => {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [bridge], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        ADAPTIVE_ROUTER_STDIO_INPUT_TIMEOUT_MS: "50",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("stdio bridge did not time out while waiting for its request"));
    }, 2_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stderr });
    });
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out before receiving JSON/i);
  assert.match(result.stderr, /same command/i);
  assert.match(result.stderr, /confirmed writable session/i);
});

test("frozen-inventory instructions make bridge input delivery and one corrective retry explicit", async () => {
  const skill = await readFile(
    join(pluginRoot, "skills", "adaptive-model-router", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /`tty:\s*true`/i);
  assert.match(skill, /returned `session_id`/i);
  assert.match(skill, /call\s+`write_stdin`/i);
  assert.match(skill, /retry exactly\s+once/i);
  assert.match(skill, /caller input-delivery failure, not an MCP transport failure/i);
  assert.match(skill, /do not repeat a bare helper\s+launch/i);
});

test("frozen-inventory instructions provide an atomic bridge call for one-shot command tools", async () => {
  const skill = await readFile(
    join(pluginRoot, "skills", "adaptive-model-router", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /<<'ADAPTIVE_ROUTER_REQUEST'/u);
  assert.match(skill, /single command execution/i);
  assert.match(skill, /does not require[^.]*`session_id`[^.]*`write_stdin`/i);
  assert.match(skill, /PowerShell\s+here-string/i);
});

test("POSIX one-shot command execution delivers a literal bridge request atomically", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell regression");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "adaptive-router-stdio-atomic-test-"));
  try {
    const request = JSON.stringify({
      name: "get_route_status",
      arguments: { contextId: "one-shot-command-test" },
    });
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(bridge)} <<'ADAPTIVE_ROUTER_REQUEST'\n${request}\nADAPTIVE_ROUTER_REQUEST`;
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ADAPTIVE_ROUTER_HOME: home,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      timeout: 20_000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.transport, "stdio-bridge");
    assert.equal(output.tool, "get_route_status");
    assert.equal(output.isError, false);
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
