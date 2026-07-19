import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNodeRuntime, supportsNodeRuntime } from "../scripts/lib/node-discovery.mjs";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pluginRoot, "scripts", "node-launcher.mjs");

test("runtime discovery accepts the boundary and a leading v", () => {
  assert.equal(supportsNodeRuntime("v24.14.9"), false);
  assert.equal(supportsNodeRuntime("v24.15.0"), true);
  assert.equal(supportsNodeRuntime("v25.0.0"), true);
});

test("runtime discovery finds a newer NVM runtime when Codex starts with Node 22", () => {
  const nvmRoot = "/Users/example/NVM root 中文";
  const versionsRoot = `${nvmRoot}/versions/node`;
  const oldNode = "/old/bin/node";
  const expected = `${versionsRoot}/v24.15.0/bin/node`;
  const versions = new Map([[oldNode, "v22.22.1"], [expected, "v24.15.0"]]);
  const entries = ["v14.4.0", "v24.15.0"].map((name) => ({ name, isDirectory: () => true }));

  const runtime = discoverNodeRuntime({
    currentExecutable: oldNode,
    currentVersion: "22.22.1",
    env: { PATH: "/old/bin", NVM_DIR: nvmRoot },
    platform: "darwin",
    userHome: "/Users/example",
    readDirectory: (root) => root === versionsRoot ? entries : [],
    probe: (candidate) => versions.get(candidate) || null,
  });
  assert.deepEqual(runtime, { executable: expected, version: "v24.15.0" });
});

test("runtime discovery handles a Windows NVM path with spaces", () => {
  const oldNode = "C:\\Old Node\\node.exe";
  const expected = "C:\\Users\\Example User\\nvm\\node.exe";
  const runtime = discoverNodeRuntime({
    currentExecutable: oldNode,
    currentVersion: "22.22.1",
    env: { PATH: "", NVM_HOME: "C:\\Users\\Example User\\nvm" },
    platform: "win32",
    userHome: "C:\\Users\\Example User",
    probe: (candidate) => candidate === expected ? "v24.15.0" : null,
  });
  assert.deepEqual(runtime, { executable: expected, version: "v24.15.0" });
});

test("runtime launcher preserves stdio, arguments, Unicode, and environment", async () => {
  const project = await temporaryProject("adaptive launcher Unicode 空格 ");
  try {
    const child = join(project.root, "child fixture.mjs");
    await writeFile(child, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, marker: process.env.RUNTIME_LAUNCHER_MARKER }));
});
`);
    const result = spawnSync(process.execPath, [launcher, child, "argument 中文"], {
      encoding: "utf8",
      input: "stdin-marker",
      env: { ...process.env, ADAPTIVE_ROUTER_NODE: process.execPath, RUNTIME_LAUNCHER_MARKER: "env-marker" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["argument 中文"],
      input: "stdin-marker",
      marker: "env-marker",
    });
  } finally {
    await project.cleanup();
  }
});
