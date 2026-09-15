import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AppServerClient } from "../scripts/lib/app-server.mjs";

test("actual native cold resume resolves the new MCP configuration for the same persisted task", {
  skip: !process.env.ADAPTIVE_ROUTER_NATIVE_CLI && "Requires an explicit native CLI; this test does not run Hooks or model inference",
  timeout: 60_000,
}, async (t) => {
  assert.match(process.env.CODEX_HOME || "", /router-test-process-[^/\\]+[/\\]codex$/);
  assert.equal(process.env.ADAPTIVE_ROUTER_INVOCATION_ID, "");
  const root = mkdtempSync(join(tmpdir(), "router-native-entry-"));
  const script = join(root, "mcp.mjs"), config = join(process.env.CODEX_HOME, "config.toml");
  assert.equal(existsSync(config), false, "The fixture owns a fresh isolated configuration");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(script, `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('close',()=>process.exit(0));
lines.on('line',l=>{const q=JSON.parse(l);if(q.id==null)return;let result;
if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-entry',version:process.argv[2]}};
else if(q.method==='tools/list')result={tools:[{name:'entry',description:'Read this isolated fixture entry',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};
else if(q.method==='tools/call')result={content:[{type:'text',text:process.argv[2]}]};else result={};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
  const configure = (label) => writeFileSync(config, `model = "gpt-6-astra"\n[mcp_servers.entry_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([script, label])}\nstartup_timeout_sec = 10\n`, { mode: 0o600 });
  const client = () => new AppServerClient({ timeoutMs: 15_000,
    resolveImpl: async () => ({ path: process.env.ADAPTIVE_ROUTER_NATIVE_CLI, kind: "direct" }),
    spawnImpl: (command, args, options) => spawn(command, args, { ...options, cwd: root }) });
  let a = null, b = null;
  async function close(value) {
    const child = value?.process;
    if (child && child.exitCode === null) { const done = once(child, "exit"); value.close(); await done; }
    else value?.close();
  }
  try {
    configure("A"); a = client(); await a.start();
    const started = await a.request("thread/start", { cwd: root, ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
    const id = started.thread.id;
    const read = async (value) => {
      await value.request("mcpServerStatus/list", { threadId: id });
      return value.request("mcpServer/tool/call", { threadId: id, server: "entry_probe", tool: "entry", arguments: {} });
    };
    assert.match(JSON.stringify(await read(a)), /"text":"A"/);
    // Native start alone does not persist a task. Complete this harmless native
    // shell turn before inspecting/resuming the real source; never invent it.
    const completed = a.createWaiter((message) => message.method === "turn/completed" && message.params?.threadId === id, Date.now() + 10_000);
    completed.promise.catch(() => {});
    await a.request("thread/shellCommand", { threadId: id, command: "echo native-entry-persisted", timeoutMs: 2_000 });
    await completed.promise;
    const persisted = await a.request("thread/read", { threadId: id, includeTurns: false });
    assert.ok(persisted.thread.path && existsSync(persisted.thread.path));
    await close(a); a = null;
    configure("B"); b = client(); await b.start();
    const resumed = await b.request("thread/resume", { threadId: id, cwd: root, excludeTurns: true });
    assert.equal(resumed.thread.id, id);
    assert.match(JSON.stringify(await read(b)), /"text":"B"/);
    t.diagnostic(JSON.stringify({ first: "A", afterNativeColdResume: "B", hookExecuted: false, modelTurnStarted: false, globalConfigTouched: false }));
  } finally {
    await close(a); await close(b); rmSync(root, { recursive: true, force: true }); rmSync(config, { force: true });
  }
});
