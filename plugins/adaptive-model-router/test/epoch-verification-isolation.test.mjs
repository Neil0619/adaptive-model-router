import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareRuntimeHostEntry } from "../scripts/lib/runtime-host-entry.mjs";
import { qualifyHostEpochPublication } from "../scripts/lib/runtime-epoch.mjs";
import { prepareEpochVerificationEntry } from "../scripts/lib/epoch-verification-entry.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = (root) => [root, ...readdirSync(root, { recursive: true }).map((path) => join(root, path))].sort().map((path) => {
  const stat = statSync(path, { bigint: true });
  return [path.slice(root.length), String(stat.mtimeNs), String(stat.ctimeNs), stat.isFile() ? sha(readFileSync(path)) : null];
});
function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "router-entry-isolation-test-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "router-writer-qualification-")));
  const canary = join(root, "original-bound-home"); mkdirSync(canary);
  const env = { ...process.env, ADAPTIVE_ROUTER_HOME: join(home, "state"), PLUGIN_DATA: join(home, "state"),
    CODEX_HOME: join(home, "codex"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "" };
  try {
    const initialized = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const {RouterStore}=await import(${JSON.stringify(pathToFileURL(join(source, "scripts/lib/database.mjs")).href)});new RouterStore().close();`],
    { env: { ...env, ADAPTIVE_ROUTER_HOME: canary, PLUGIN_DATA: canary }, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const a = prepareRuntimeHostEntry(source, join(root, "original-a/entry"), canary);
    const b = prepareRuntimeHostEntry(source, join(root, "original-b/entry"), canary);
    const runVerifier = (script, aa = a.root, bb = b.root) => spawnSync(process.execPath, [join(source, "scripts", script), aa, bb, home],
      { env, encoding: "utf8", timeout: 30000 });
    run({ root, home, canary, a, b, runVerifier, env });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}

for (const script of ["verify-cold-epoch-compatibility.mjs", "verify-host-epoch-compatibility.mjs"])
  test(`${script} executes materialized native entries only in its isolated home and preserves original bound bytes`, () => fixture((f) => {
    const before = files(f.canary), a = files(f.a.root), b = files(f.b.root);
    const result = f.runVerifier(script);
    assert.deepEqual(files(f.canary), before, "Native verification must not open or write the original binding even when it rejects with exit zero");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(files(f.a.root), a); assert.deepEqual(files(f.b.root), b);
  }));

for (const stderr of ["Adaptive Model Router runtime dispatch refused: fixture\nAdaptive Model Router runtime_coverage_gap: native Hook dispatch was not recorded.\n", ""])
test(`cold verification requires actual Hook entry when an empty launcher exits zero ${stderr ? "with refusal" : "silently"}`, () => fixture((f) => {
  const broken = join(f.root, "refused-entry"); cpSync(f.b.root, broken, { recursive: true });
  writeFileSync(join(broken, "scripts/node-launcher.mjs"), `process.stderr.write(${JSON.stringify(stderr)});process.exit(0);\n`);
  const before = files(f.canary), result = f.runVerifier("verify-cold-epoch-compatibility.mjs", f.a.root, broken);
  assert.notEqual(result.status, 0, "Zero exit status without the exact completed native invocation is not reachability evidence");
  assert.deepEqual(files(f.canary), before);
}));

for (const cold of [true, false]) test(`source-owned ${cold ? "cold" : "ordinary"} publication isolates materialized A/B bindings throughout both suites`, () => fixture((f) => {
  const before = files(f.canary), a = files(f.a.root), b = files(f.b.root);
  assert.ok(qualifyHostEpochPublication(f.a, f.b, { cold }));
  assert.deepEqual(files(f.canary), before); assert.deepEqual(files(f.a.root), a); assert.deepEqual(files(f.b.root), b);
}));

test("temporary entry mapping preserves writer and descriptor bytes and detects later adapter or writer changes", () => fixture((f) => {
  const keys = ["ADAPTIVE_ROUTER_HOME", "PLUGIN_DATA", "CODEX_HOME", "ADAPTIVE_ROUTER_LOCAL_ONLY"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = f.env[key];
    const entry = prepareEpochVerificationEntry(f.b, f.home, "candidate");
    assert.equal(entry.writerDigest, f.b.writerDigest); assert.deepEqual(entry.descriptor, f.b.descriptor);
    assert.notEqual(entry.digest, f.b.digest);
    const host = JSON.parse(readFileSync(join(entry.root, "runtime-host.json")));
    assert.equal(host.dataHome, join(f.home, "state")); assert.equal(host.shellRoot, entry.root);
    for (const path of ["runtime-host.json", "scripts/hook.mjs", "runtime.json"]) {
      const bytes = readFileSync(join(entry.root, path)); writeFileSync(join(entry.root, path), Buffer.concat([bytes, Buffer.from("\n")]));
      assert.throws(() => entry.verify(), /integrity changed/); writeFileSync(join(entry.root, path), bytes);
    }
    entry.verify();
  } finally { for (const key of keys) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
}));

for (const [name, path, mutate] of [
  ["redirected MCP", ".mcp.json", (value) => { value.mcpServers["adaptive-model-router"].args[1] = "/foreign/entry.mjs"; }],
  ["unmapped Hook", "hooks/hooks.json", (value) => { value.hooks.SessionStart[0].hooks[0][process.platform === "win32" ? "commandWindows" : "command"] += " --extra"; }],
  ["unmapped retained Hook dependency", "runtime-host.json", (value) => { value.hookShellRoot = "/foreign/shell"; }],
]) test(`${name} fails before opening writer state`, () => fixture((f) => {
  const broken = join(f.root, "invalid-mapping"); cpSync(f.b.root, broken, { recursive: true });
  const value = JSON.parse(readFileSync(join(broken, path))); mutate(value); writeFileSync(join(broken, path), JSON.stringify(value));
  const before = files(f.canary), result = f.runVerifier("verify-cold-epoch-compatibility.mjs", f.a.root, broken);
  assert.notEqual(result.status, 0); assert.equal(existsSync(join(f.home, "state/router.sqlite3")), false);
  assert.deepEqual(files(f.canary), before);
}));
