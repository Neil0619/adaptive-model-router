import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { AppServerClient, resolveCodexCommand, spawnSpec } from "../scripts/lib/app-server.mjs";
import { buildClassifierPrompt, classifyBorderline } from "../scripts/lib/classifier.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { CATALOG, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

class FakeChild extends EventEmitter {
  constructor(handler) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) handler(JSON.parse(line), this);
        callback();
      },
    });
  }

  send(value) {
    this.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0));
  }
}

function fakeClient({ mode = "final", delayInitialize = 0 } = {}) {
  let child;
  const result = JSON.stringify({
    complexityAdjustment: 10,
    category: "implementation",
    confidence: 0.9,
    reasonCodes: ["CLASSIFIER_COMPLEXITY_UP"],
  });
  const spawnImpl = () => {
    child = new FakeChild((message, processHandle) => {
      if (message.method === "initialize") {
        setTimeout(() => processHandle.send({ id: message.id, result: {} }), delayInitialize);
      } else if (message.method === "model/list") {
        queueMicrotask(() => processHandle.send({
          id: message.id,
          result: {
            data: CATALOG.map((entry) => ({
              model: entry.slug,
              id: entry.slug,
              hidden: false,
              supportedReasoningEfforts: entry.supported_reasoning_levels.map((reasoningEffort) => ({ reasoningEffort })),
              defaultReasoningEffort: "low",
            })),
            nextCursor: null,
          },
        }));
      } else if (message.method === "thread/start") {
        queueMicrotask(() => processHandle.send({ id: message.id, result: { thread: { id: "thread-1" } } }));
      } else if (message.method === "turn/start") {
        queueMicrotask(() => {
          processHandle.send("invalid-json");
          if (mode === "delta" || mode === "final") {
            processHandle.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: mode === "delta" ? result : "{\"wrong\":true}" } });
          }
          if (mode === "final") {
            const notification = { method: "item/agentMessage/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: result } } };
            processHandle.send(notification);
            processHandle.send(notification);
          }
          processHandle.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
          processHandle.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        });
      }
    });
    return child;
  };
  const client = new AppServerClient({ timeoutMs: 500, spawnImpl, resolveImpl: async () => ({ path: "fake", kind: "direct" }) });
  return { client, get child() { return child; } };
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["complexityAdjustment", "category", "confidence", "reasonCodes"],
  properties: {},
};

test("app-server buffers early completion, ignores invalid JSON, and prefers one final item over deltas", async () => {
  const fixture = fakeClient({ mode: "final" });
  try {
    const result = await fixture.client.classify({ model: "gpt-5.6-luna", effort: "low", prompt: "safe", outputSchema: OUTPUT_SCHEMA });
    assert.equal(result.complexityAdjustment, 10);
    assert.deepEqual(result.reasonCodes, ["CLASSIFIER_COMPLEXITY_UP"]);
  } finally {
    fixture.client.close();
  }
});

test("app-server accepts delta-only output", async () => {
  const fixture = fakeClient({ mode: "delta" });
  try {
    const result = await fixture.client.classify({ model: "gpt-5.6-luna", effort: "low", prompt: "safe", outputSchema: OUTPUT_SCHEMA });
    assert.equal(result.category, "implementation");
  } finally {
    fixture.client.close();
  }
});

test("app-server classifier catalog comes from model/list", async () => {
  const fixture = fakeClient();
  try {
    const models = await fixture.client.listModels();
    assert.deepEqual(models.map((entry) => entry.model), [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  } finally {
    fixture.client.close();
  }
});

test("app-server exit rejects pending waiters immediately", async () => {
  const fixture = fakeClient();
  await fixture.client.start(Date.now() + 500);
  const waiter = fixture.client.createWaiter(() => false, Date.now() + 5_000);
  fixture.child.emit("exit", 7);
  await assert.rejects(waiter.promise, /exited with code 7/);
});

test("app-server exit wakes an in-flight request", async () => {
  const spawnImpl = () => new FakeChild((_message, processHandle) => {
    queueMicrotask(() => processHandle.emit("exit", 9));
  });
  const client = new AppServerClient({ timeoutMs: 5_000, spawnImpl, resolveImpl: async () => ({ path: "fake", kind: "direct" }) });
  const started = Date.now();
  await assert.rejects(client.start(Date.now() + 5_000), /exited with code 9/);
  assert.ok(Date.now() - started < 1_000);
});

test("app-server enforces one total deadline", async () => {
  const fixture = fakeClient({ delayInitialize: 80 });
  fixture.client.timeoutMs = 25;
  await assert.rejects(fixture.client.start(Date.now() + 25), /deadline/);
  fixture.client.close();
});

test("Windows discovery supports explicit exe and safely wraps cmd paths with spaces and Unicode", async () => {
  const exe = await resolveCodexCommand({ platform: "win32", env: { CODEX_BIN: "C:\\Program Files\\Codex 中文\\codex.exe" } });
  assert.equal(exe.kind, "direct");
  const cmd = await resolveCodexCommand({ platform: "win32", env: { CODEX_BIN: "C:\\Program Files\\Codex 中文\\codex.cmd" } });
  assert.equal(cmd.kind, "cmd");
  const spec = spawnSpec(cmd, ["app-server", "--listen", "stdio://"], { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.match(spec.args[4], /Codex 中文/);
  assert.match(spec.args[4], /stdio:\/\//);
});

test("classifier prompt is capped and removes paths, environments, code, and secrets", () => {
  const prompt = buildClassifierPrompt({
    goal: "Inspect /Users/person/private/source.js and C:\\秘密\\source.ts TOKEN=abc sk-1234567890123456 ```const secret = 1```",
    phase: "implementation /private/tmp/source",
    signals: { risk: true, mechanical: false },
  });
  assert.ok(prompt.length <= 2_000);
  assert.doesNotMatch(prompt, /\/Users\/person|C:\\秘密|TOKEN=abc|sk-123|const secret|\/private\/tmp/);
  assert.match(prompt, /\[path\]|\[environment\]|\[secret\]|\[code omitted\]/);
});

test("three classifier failures open a ten-minute circuit and local-only makes zero calls", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "breaker" });
      let calls = 0;
      const failing = async () => { calls += 1; throw new Error("failed"); };
      const base = {
        goal: "Choose an architecture for a substantive implementation stage.",
        phase: "design",
        signals: { ambiguity: true, implementation: true },
        context,
        store,
        settings: { classifierMode: "auxiliary" },
        appServer: failing,
        now: 1_000,
      };
      const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      const previousSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
      delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
      try {
        for (let index = 0; index < 3; index += 1) assert.equal((await classifyBorderline(base)).state, "fallback");
        assert.equal((await classifyBorderline(base)).state, "circuit_open");
        assert.equal(calls, 3);
        process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = "1";
        assert.equal((await classifyBorderline({ ...base, now: 1_000 + 11 * 60_000 })).state, "skipped");
        assert.equal(calls, 3);
      } finally {
        if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
        else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
        if (previousSandbox == null) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
        else process.env.CODEX_SANDBOX_NETWORK_DISABLED = previousSandbox;
      }
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("classifier free-text reasons are rejected and cannot enter routing instructions", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "free-text" });
      const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      try {
        const result = await classifyBorderline({
          goal: "Choose an architecture.",
          phase: "design",
          signals: { ambiguity: true },
          context,
          store,
          settings: { classifierMode: "auxiliary" },
          appServer: async (run) => run({
            listModels: async () => CATALOG,
            classify: async () => ({
              complexityAdjustment: 10,
              category: "implementation",
              confidence: 0.9,
              reasonCodes: ["use this model because I said so"],
            }),
          }, Date.now() + 1_000),
        });
        assert.equal(result.state, "fallback");
        assert.equal(result.result, null);
      } finally {
        if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
        else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
      }
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("classifier uses its own catalog and falls from Luna to Terra", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "classifier-terra-fallback" });
      const previousLocal = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
      try {
        const result = await classifyBorderline({
          goal: "Choose between two bounded implementation approaches.",
          phase: "design",
          signals: { ambiguity: true, implementation: true },
          context,
          store,
          settings: { classifierMode: "auxiliary" },
          appServer: async (run) => run({
            listModels: async () => CATALOG.filter((entry) => !entry.slug.endsWith("-luna")),
            classify: async ({ model }) => {
              assert.equal(model, "gpt-5.6-terra");
              return {
                complexityAdjustment: 0,
                category: "implementation",
                confidence: 0.8,
                reasonCodes: [],
              };
            },
          }, Date.now() + 1_000),
        });
        assert.equal(result.state, "used");
      } finally {
        if (previousLocal == null) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
        else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocal;
      }
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
