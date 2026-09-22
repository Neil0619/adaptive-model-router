import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { enrollRuntimeFixture } from "./runtime-fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(pluginRoot, "scripts", "stdio-tool.mjs");

// This host deadline includes Node startup, module loading and child shutdown.
// It is separate from the bridge's input and MCP protocol timers.
async function bridgeWithOpenStdin({ env, input, expectedCode = 0, timeoutMs = 20_000 }) {
  const child = spawn(process.execPath, [bridge], {
    cwd: pluginRoot, env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    detached: process.platform !== "win32",
  });
  let stdout = "", stderr = "", spawnError, stdinError, timedOut = false, stopTimer;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { spawnError = error; });
  child.stdin.on("error", (error) => { stdinError = error; });
  const closed = new Promise((resolveClosed) => {
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  let failCleanup;
  const cleanupFailed = new Promise((_, reject) => { failCleanup = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      // Kill only this test's owned tree, never a parent or a process-name match.
      // Killing the bridge alone can leave its launcher/MCP holding SQLite.
      if (process.platform === "win32") {
        const stop = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          encoding: "utf8", timeout: 5_000, windowsHide: true,
        });
        if (stop.error || stop.status !== 0) throw stop.error || new Error(stop.stderr || stop.stdout);
      } else process.kill(-child.pid, "SIGKILL");
      stopTimer = setTimeout(() => failCleanup(new Error(`owned bridge tree did not close after termination; retain its fixture: ${JSON.stringify({ stdout, stderr })}`)), 5_000);
    } catch (error) {
      failCleanup(new Error(`could not terminate the owned bridge tree; retain its fixture: ${JSON.stringify({ stdout, stderr })}`, { cause: error }));
    }
  }, timeoutMs);
  // Deliberately keep the parent's pipe open: neither successful line parsing
  // nor an input timeout may depend on the caller sending EOF.
  if (input !== undefined) child.stdin.write(input);
  try {
    const result = await Promise.race([closed, cleanupFailed]);
    clearTimeout(timer);
    clearTimeout(stopTimer);
    let cleanupError;
    if (child.pid && (timedOut || stdinError || result.code !== expectedCode || result.signal)) {
      if (process.platform === "win32") {
        // A vanished parent cannot safely identify its descendants with /T.
        // Retain failed fixtures instead of deleting a possibly open database.
        if (!timedOut) cleanupError = new Error("bridge exited abnormally; descendant cleanup is unverified on Windows");
      } else {
        try {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
          const deadline = Date.now() + 5_000;
          while (true) {
            try { process.kill(-child.pid, 0); }
            catch (error) { if (error.code === "ESRCH") break; throw error; }
            if (Date.now() >= deadline) throw new Error("owned process group remains after termination");
            await delay(25);
          }
        } catch (error) { cleanupError = error; }
      }
    }
    return { ...result, stdout, stderr, timedOut, spawnError, stdinError, cleanupError };
  } finally {
    clearTimeout(timer);
    clearTimeout(stopTimer);
  }
}

test("stdio bridge calls the installed route_stage contract for a frozen task inventory", async () => {
  const home = await mkdtemp(join(tmpdir(), "adaptive-router-stdio-test-"));
  enrollRuntimeFixture({ home, shellRoot: pluginRoot, cwd: pluginRoot, contextId: "frozen-task-bridge-test" });
  try {
    const result = spawnSync(process.execPath, [bridge], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ADAPTIVE_ROUTER_HOME: home,
        CODEX_THREAD_ID: "frozen-task-bridge-test",
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
  enrollRuntimeFixture({ home, shellRoot: pluginRoot, cwd: pluginRoot, contextId: "open-stdin-line-test" });
  let passed = false;
  try {
    const output = await bridgeWithOpenStdin({
      env: { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home,
        CODEX_THREAD_ID: "open-stdin-line-test", ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
      input: `${JSON.stringify({
        name: "get_route_status",
        arguments: { contextId: "open-stdin-line-test" },
      })}\n`,
    });
    assert.ifError(output.spawnError);
    assert.ifError(output.stdinError);
    assert.equal(output.timedOut, false, `bridge exceeded the host test deadline: ${JSON.stringify(output)}`);
    assert.equal(output.code, 0, JSON.stringify(output));
    assert.ifError(output.cleanupError);
    const result = JSON.parse(output.stdout);
    assert.equal(result.transport, "stdio-bridge");
    assert.equal(result.isError, false);
    passed = true;
  } finally {
    if (passed) await rm(home, { recursive: true, force: true });
    else console.error(`stdio test failed; retaining fixture: ${home}`);
  }
});

test("stdio bridge fails explicitly when an open stdin never supplies a request", async () => {
  const home = await mkdtemp(join(tmpdir(), "adaptive-router-stdio-empty-test-"));
  let passed = false;
  try {
    const result = await bridgeWithOpenStdin({
      expectedCode: 1,
      env: { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home,
        ADAPTIVE_ROUTER_STDIO_INPUT_TIMEOUT_MS: "50" },
    });
    assert.ifError(result.spawnError);
    assert.ifError(result.stdinError);
    assert.equal(result.timedOut, false, `bridge exceeded the host test deadline: ${JSON.stringify(result)}`);
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.ifError(result.cleanupError);
    assert.match(result.stderr, /timed out before receiving JSON/i);
    assert.match(result.stderr, /same command/i);
    assert.match(result.stderr, /confirmed writable session/i);
    passed = true;
  } finally {
    if (passed) await rm(home, { recursive: true, force: true });
    else console.error(`stdio test failed; retaining fixture: ${home}`);
  }
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
  enrollRuntimeFixture({ home, shellRoot: pluginRoot, cwd: pluginRoot, contextId: "one-shot-command-test" });
  try {
    const request = JSON.stringify({
      name: "get_route_status",
      arguments: { contextId: "one-shot-command-test" },
    });
    const nodeLink = join(home, "node ' \" $ROUTER_TEST_LITERAL $(printf injected) $((40 + 2)) `printf expanded` 中文");
    const bridgeLink = join(home, "bridge ' \" $ROUTER_TEST_LITERAL $(printf inert) $((20 + 4)) `printf literal` 中文.mjs");
    await symlink(process.execPath, nodeLink);
    await symlink(bridge, bridgeLink);
    for (const [nodePath, bridgePath] of [[process.execPath, bridge], [nodeLink, bridgeLink]]) {
      // Keep the shell program fixed and expand child-local path values only inside quotes.
      const command = `"$ADAPTIVE_ROUTER_TEST_NODE" "$ADAPTIVE_ROUTER_TEST_BRIDGE" <<'ADAPTIVE_ROUTER_REQUEST'\n${request}\nADAPTIVE_ROUTER_REQUEST`;
      const result = spawnSync("/bin/sh", ["-c", command], {
        cwd: pluginRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ADAPTIVE_ROUTER_HOME: home,
          CODEX_THREAD_ID: "one-shot-command-test",
          ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
          ADAPTIVE_ROUTER_TEST_NODE: nodePath,
          ADAPTIVE_ROUTER_TEST_BRIDGE: bridgePath,
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
    }
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
    enrollRuntimeFixture({ home: pluginData, shellRoot: pluginRoot, cwd: pluginRoot, contextId: "source-checkout-installed-data-test" });
    const result = spawnSync(process.execPath, [bridge], {
      cwd: pluginRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: "source-checkout-installed-data-test",
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
