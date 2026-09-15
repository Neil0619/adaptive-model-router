// Source-owned, disposable reachability harness. It creates no publication or
// host trust proof and is never used by the production launcher.
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";
import { parseHookNodeCommand, renderHookNodeCommand } from "./hook-command.mjs";

export function assertEpochVerificationHome(home) {
  assert.match(basename(home || ""), /^router-writer-qualification-[A-Za-z0-9]+$/u);
  assert.equal(realpathSync(dirname(home)), realpathSync(tmpdir()));
  assert.equal(lstatSync(home).isSymbolicLink(), false); assert.ok(lstatSync(home).isDirectory());
  for (const [name, suffix] of [["ADAPTIVE_ROUTER_HOME", "state"], ["PLUGIN_DATA", "state"], ["CODEX_HOME", "codex"]])
    assert.equal(resolve(process.env[name] || ""), resolve(home, suffix));
  assert.equal(process.env.ADAPTIVE_ROUTER_LOCAL_ONLY, "1");
  for (const path of ["state", "codex", "native-entries", "state/router.sqlite3", "state/router.sqlite3-wal", "state/router.sqlite3-shm"]) {
    try { assert.equal(lstatSync(join(home, path)).isSymbolicLink(), false, "Redirected verification state"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// Preserve the exact writer/descriptor and every other file. For a materialized
// shell, only its validated native adapter paths and data binding are mapped.
// A retained copy may name an original shell elsewhere: never execute or open
// that shell or its dataHome while establishing the temporary mapping.
export function prepareEpochVerificationEntry(original, home, name) {
  assertEpochVerificationHome(home); verifyRuntimePackage(original);
  assert.ok(["source", "candidate"].includes(name));
  const root = join(home, "native-entries", name), replacements = new Map();
  assert.equal(existsSync(root), false, "Verification entry must be newly created");
  const read = (path) => JSON.parse(readFileSync(join(original.root, path), "utf8"));
  if (existsSync(join(original.root, "runtime-host.json"))) {
    const host = read("runtime-host.json"), mcp = read(".mcp.json"), hooks = read("hooks/hooks.json");
    assert.equal(host.schema, 1); assert.ok(isAbsolute(host.shellRoot)); assert.ok(isAbsolute(host.dataHome));
    assert.ok(!host.hookShellRoot || host.hookShellRoot === host.shellRoot, "A separate retained Hook entry requires its own verified temporary mapping");
    const server = mcp.mcpServers?.["adaptive-model-router"];
    assert.deepEqual(server?.args, [join(host.shellRoot, "scripts/node-launcher.mjs"), join(host.shellRoot, "scripts/mcp-server.mjs")]);
    assert.equal(server.cwd, host.shellRoot); assert.ok(isAbsolute(server.command));
    server.args = [join(root, "scripts/node-launcher.mjs"), join(root, "scripts/mcp-server.mjs")]; server.cwd = root;
    const field = process.platform === "win32" ? "commandWindows" : "command";
    for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
      const command = parseHookNodeCommand(hook[field]), mode = /\s([a-z-]+)$/u.exec(command.suffix)?.[1];
      assert.ok(mode); assert.equal(command.executable, server.command);
      assert.equal(command.suffix, ` "${join(host.shellRoot, "scripts/node-launcher.mjs")}" "${join(host.shellRoot, "scripts/hook.mjs")}" ${mode}`,
        "Unmapped native Hook command cannot be treated as an equivalent entry");
      hook[field] = renderHookNodeCommand(command.executable, ` "${join(root, "scripts/node-launcher.mjs")}" "${join(root, "scripts/hook.mjs")}" ${mode}`);
    }
    host.shellRoot = root; host.dataHome = join(home, "state");
    if (host.hookShellRoot) host.hookShellRoot = root;
    for (const [path, value] of [["runtime-host.json", host], [".mcp.json", mcp], ["hooks/hooks.json", hooks]])
      replacements.set(path, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
  }
  mkdirSync(dirname(root), { recursive: true }); cpSync(original.root, root, { recursive: true, force: false, errorOnExist: true });
  for (const [path, bytes] of replacements) writeFileSync(join(root, path), bytes);
  const entry = inspectRuntimePackage(root, { legacy: original.descriptor.shellProtocolVersion === 1 });
  const verify = () => {
    verifyRuntimePackage(original); verifyRuntimePackage(entry);
    assert.equal(entry.writerDigest, original.writerDigest, "Temporary native adapter changed the exact writer");
    assert.deepEqual(entry.descriptor, original.descriptor, "Temporary native adapter changed the descriptor");
    const compare = (directory, prefix = "") => {
      for (const filename of readdirSync(directory)) {
        const path = prefix + filename;
        if (lstatSync(join(directory, filename)).isDirectory()) compare(join(directory, filename), `${path}/`);
        else assert.ok(readFileSync(join(root, path)).equals(replacements.get(path) || readFileSync(join(original.root, path))),
          `Temporary native adapter changed an unmapped file: ${path}`);
      }
    };
    compare(original.root); return entry;
  };
  verify(); return { ...entry, verify };
}

export function assertEpochEntryProcess(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr || "", /runtime dispatch refused|runtime_coverage_gap/iu,
    "A refused native entry with exit zero is not successful reachability");
}

export function assertEpochHookInvocation(db, context, generation, result, previous, eventName) {
  assertEpochEntryProcess(result);
  const added = db.prepare("SELECT * FROM runtime_invocations WHERE project_id=? AND context_key=?")
    .all(context.projectId, context.contextKey).filter((row) => !previous.has(row.id));
  assert.equal(added.length, 1, "Native Hook must create one new invocation in the isolated home");
  const row = added[0];
  assert.equal(row.kind, `hook:${eventName}`); assert.equal(row.generation, generation);
  assert.equal(row.pid, result.pid); assert.equal(row.state, "completed", "Native Hook execution did not complete");
}
