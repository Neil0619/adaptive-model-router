#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "router-test-process-"));
try {
  const files = process.argv.slice(2);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(files.length ? files
    : readdirSync(join(source, "test")).filter((name) => name.endsWith(".test.mjs")).map((name) => join("test", name)))], {
    cwd: source, stdio: "inherit", env: { ...process.env, ADAPTIVE_ROUTER_HOME: join(root, "state"),
      CODEX_HOME: join(root, "codex"), PLUGIN_DATA: join(root, "state"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "" },
  });
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
