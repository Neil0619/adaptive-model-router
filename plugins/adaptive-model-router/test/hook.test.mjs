import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { parseControlPrompt } from "../scripts/lib/control.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(pluginRoot, "scripts", "hook.mjs");

function runHook(mode, input, home) {
  return spawnSync(process.execPath, [hookPath, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ADAPTIVE_ROUTER_HOME: home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
  });
}

function runHookAsync(mode, input, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, mode], {
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("only exact complete control prefixes and known commands parse", () => {
  assert.deepEqual(parseControlPrompt("router: off"), { command: "disable" });
  assert.deepEqual(parseControlPrompt("router: history 5"), { command: "history", limit: 5 });
  assert.deepEqual(parseControlPrompt("路由器：历史"), { command: "history", limit: 10 });
  assert.deepEqual(parseControlPrompt("路由器：记录 20"), { command: "history", limit: 20 });
  assert.deepEqual(parseControlPrompt("路由器：锁定 gpt-5.6-sol high 一次"), {
    command: "lock", model: "gpt-5.6-sol", effort: "high", scope: "once",
  });
  assert.deepEqual(parseControlPrompt("router: global on"), { command: "global_enable" });
  assert.deepEqual(parseControlPrompt("路由器：全局关闭"), { command: "global_disable" });
  assert.deepEqual(parseControlPrompt("router: manual"), { command: "manual" });
  assert.deepEqual(parseControlPrompt("路由器：本任务自动"), { command: "auto", scope: "session" });
  for (const prompt of [
    "Please discuss router: off",
    "不要执行 router: off",
    "> router: off",
    "```\nrouter: off\n```",
    "first\nrouter: off",
    "路由器: 禁用",
    "router：off",
    "router: ordinary discussion",
    "路由器：普通讨论",
    "router: history 0",
    "router: history 21",
    "router: history two",
    "router: history 5 extra",
  ]) assert.equal(parseControlPrompt(prompt), null, prompt);
});

test("global automatic activation is opt-in, crosses projects, and detects later root-model changes", async () => {
  const project = await temporaryProject("adaptive auto Unicode 自动 ");
  try {
    const base = { cwd: project.root, session_id: "auto-session", model: "gpt-5.6-sol" };
    const before = runHook("prompt", { ...base, prompt: "Implement a parser." }, project.home);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stdout, "");

    const enabled = runHook("prompt", { ...base, prompt: "路由器：全局开启" }, project.home);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /global automatic activation is enabled/);

    const first = runHook("prompt", { ...base, prompt: "Implement a parser." }, project.home);
    assert.equal(first.status, 0, first.stderr);
    const firstContext = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.match(firstContext, /global automatic activation is enabled/);
    assert.match(firstContext, /gpt-5\.6-sol/);
    assert.match(firstContext, /Use "auto-session" as the contextId argument for every Adaptive Model Router MCP call in the current task and never substitute cwd\/project paths\./);
    assert.doesNotMatch(firstContext, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(firstContext, /Implement a parser|Use (?:the )?(?:cwd|project path) as the contextId/i);
    assert.doesNotMatch(firstContext, /unresolved active root-model change/);

    const otherRoot = join(project.root, "另一个 项目");
    await mkdir(otherRoot);
    const other = runHook("prompt", {
      cwd: otherRoot,
      session_id: "other-session",
      model: "gpt-5.6-terra",
      prompt: "Review the module.",
    }, project.home);
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stdout, /global automatic activation is enabled/);

    const changed = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "Continue implementing.",
    }, project.home);
    assert.equal(changed.status, 0, changed.stderr);
    const changedContext = JSON.parse(changed.stdout).hookSpecificOutput.additionalContext;
    assert.match(changedContext, /unresolved active root-model change/);
    assert.match(changedContext, /HOST_MODEL_INTENT_PENDING/);
    assert.match(changedContext, /Use "auto-session" as the contextId argument for every Adaptive Model Router MCP call in the current task and never substitute cwd\/project paths\./);
    assert.doesNotMatch(changedContext, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(changedContext, /Implement a parser|Continue implementing/);
    assert.doesNotMatch(changedContext, /Use (?:the )?(?:cwd|project path) as the contextId/i);

    const pendingHistory = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "router: history 1",
    }, project.home);
    assert.match(pendingHistory.stdout, /router: manual/);
    assert.match(pendingHistory.stdout, /router: auto session/);

    const reminder = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "Unrelated next request.",
    }, project.home);
    assert.match(reminder.stdout, /unresolved active root-model change/);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "auto-session" });
      const state = store.hostModelState(context);
      assert.equal(state.taskMode, "pending_confirmation");
      assert.equal(state.pendingChange.fromModel, "gpt-5.6-sol");
      assert.equal(state.pendingChange.toModel, "gpt-5.6-terra");
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM host_model_changes WHERE status = 'pending'").get().count), 1);
      store.close();
    });

    const manual = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "路由器：本任务手动",
    }, project.home);
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(manual.stdout, /manual-root mode/);
    const manualTurn = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "Continue in the selected root model.",
    }, project.home);
    assert.match(manualTurn.stdout, /manual_root mode/);
    assert.doesNotMatch(manualTurn.stdout, /meaningful substantive stage boundary/);
    const manualContext = JSON.parse(manualTurn.stdout).hookSpecificOutput.additionalContext;
    assert.match(manualContext, /Use "auto-session" as the contextId argument for every Adaptive Model Router MCP call in the current task and never substitute cwd\/project paths\./);
    assert.doesNotMatch(manualContext, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(manualContext, /Continue in the selected root model|Use (?:the )?(?:cwd|project path) as the contextId/i);

    const resumed = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "路由器：本任务自动",
    }, project.home);
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedTurn = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "Resume implementation.",
    }, project.home);
    assert.match(resumedTurn.stdout, /global automatic activation is enabled/);

    const hidden = runHook("prompt", {
      ...base,
      model: "sk-super-secret-value-123456",
      prompt: "Continue after an invalid host model field.",
    }, project.home);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.match(hidden.stdout, /host-managed/);
    assert.doesNotMatch(hidden.stdout, /sk-super-secret/);

    const changedAgain = runHook("prompt", {
      ...base,
      model: "gpt-5.6-sol",
      prompt: "One more substantive stage.",
    }, project.home);
    assert.match(changedAgain.stdout, /HOST_MODEL_INTENT_PENDING/);
    const globallyOff = runHook("prompt", {
      ...base,
      model: "gpt-5.6-sol",
      prompt: "router: global off",
    }, project.home);
    assert.match(globallyOff.stdout, /global automatic activation is disabled/);
    const offTurn = runHook("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: "No automatic context now.",
    }, project.home);
    assert.equal(offTurn.stdout, "");
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "auto-session" });
      assert.equal(store.hostModelState(context).taskMode, "automatic");
      assert.equal(store.getSettings(context).autoActivate, false);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM host_model_changes WHERE status = 'cancelled'").get().count), 1);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("concurrent prompt hooks create exactly one pending event for one model change", async () => {
  const project = await temporaryProject("adaptive hook concurrent ");
  try {
    const base = { cwd: project.root, session_id: "parallel", model: "gpt-5.6-sol" };
    assert.equal(runHook("prompt", { ...base, prompt: "router: global on" }, project.home).status, 0);
    assert.equal(runHook("prompt", { ...base, prompt: "Baseline task" }, project.home).status, 0);
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) => runHookAsync("prompt", {
      ...base,
      model: "gpt-5.6-terra",
      prompt: `Concurrent task ${index}`,
    }, project.home)));
    assert.equal(results.every((result) => result.status === 0), true, results.map((result) => result.stderr).join("\n"));
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "parallel" });
      assert.equal(store.hostModelState(context).taskMode, "pending_confirmation");
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM host_model_changes WHERE status = 'pending'").get().count), 1);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM host_model_changes").get().count), 1);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("prompt hook applies a control idempotently and ignores ordinary discussion", async () => {
  const project = await temporaryProject("adaptive hook Unicode 空格 ");
  try {
    const input = { cwd: project.root, session_id: "hook-session", prompt: "router: lock gpt-5.6-sol high once" };
    const first = runHook("prompt", input, project.home);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /additionalContext/);
    const second = runHook("prompt", input, project.home);
    assert.equal(second.status, 0, second.stderr);

    const ignored = runHook("prompt", { ...input, prompt: "Do not run router: off" }, project.home);
    assert.equal(ignored.status, 0);
    assert.equal(ignored.stdout, "");

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "hook-session" });
      const resolved = store.resolveOverride(context);
      assert.equal(resolved.source, "once");
      assert.equal(resolved.override.model, "gpt-5.6-sol");
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("router off keeps task mode automatic so the disabled override controls the route reason", async () => {
  const project = await temporaryProject("adaptive off control 空格 ");
  try {
    const base = { cwd: project.root, session_id: "off-session", model: "gpt-5.6-sol" };
    assert.equal(runHook("prompt", { ...base, prompt: "router: global on" }, project.home).status, 0);
    assert.equal(runHook("prompt", { ...base, prompt: "router: manual" }, project.home).status, 0);
    assert.equal(runHook("prompt", { ...base, prompt: "router: auto session" }, project.home).status, 0);
    assert.equal(runHook("prompt", { ...base, prompt: "router: off" }, project.home).status, 0);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: project.root, contextId: "off-session" });
        assert.equal(store.hostModelState(context).taskMode, "automatic");
        assert.equal(store.resolveOverride(context).override.mode, "disabled");
        const route = await routeStage(routeInput({ contextId: "off-session" }), {
          catalog: CATALOG,
          cwd: project.root,
          store,
        });
        assert.equal(route.action, "continue");
        assert.deepEqual(route.reasonCodes, ["ROUTER_DISABLED"]);
      } finally {
        store.close();
      }
    });
  } finally {
    await project.cleanup();
  }
});

test("status and history controls visibly separate the root model from bounded stage targets", async () => {
  const project = await temporaryProject("adaptive visible Unicode 展示 ");
  try {
    await withRouterEnvironment(project, async () => {
      const contextId = "visible-session";
      const store = new RouterStore();
      store.observeHostModel(store.context({ cwd: project.root, contextId }), "gpt-5.6-sol", { detectChanges: false });
      const route = await routeStage(routeInput({
        contextId,
        override: { model: "gpt-5.6-sol", effort: "high" },
      }), { catalog: CATALOG, cwd: project.root, store });
      store.close();

      const statusResult = runHook("prompt", {
        cwd: project.root,
        session_id: contextId,
        model: "gpt-5.6-sol",
        prompt: "路由器：状态",
      }, project.home);
      assert.equal(statusResult.status, 0, statusResult.stderr);
      const status = JSON.parse(statusResult.stdout).hookSpecificOutput.additionalContext;
      assert.match(status, /根任务模型：gpt-5\.6-sol（Codex 管理，路由器未改变；effort 仅在右下角可见）/);
      assert.match(status, /委派目标 gpt-5\.6-sol \(high\)/);
      assert.match(status, new RegExp(route.routeId));
      assert.match(status, /路由器：历史 10/);
      assert.match(status, /\d{4}-\d{2}-\d{2}T/);
      assert.doesNotMatch(status, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const historyResult = runHook("prompt", {
        cwd: project.root,
        session_id: contextId,
        model: "gpt-5.6-sol",
        prompt: "路由器：历史 5",
      }, project.home);
      assert.equal(historyResult.status, 0, historyResult.stderr);
      const history = JSON.parse(historyResult.stdout).hookSpecificOutput.additionalContext;
      assert.match(history, /阶段路由\/委派决定，不是根模型热切换/);
      assert.match(history, /首次委派/);
      assert.match(history, /结果 待记录/);
      assert.match(history, new RegExp(route.routeId));
      assert.doesNotMatch(history, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const englishResult = runHook("prompt", {
        cwd: project.root,
        session_id: contextId,
        model: "gpt-5.6-sol",
        prompt: "router: history 1",
      }, project.home);
      assert.equal(englishResult.status, 0, englishResult.stderr);
      const english = JSON.parse(englishResult.stdout).hookSpecificOutput.additionalContext;
      assert.match(english, /current root-task model: gpt-5\.6-sol/i);
      assert.match(english, /initial delegation/);
      assert.match(english, /outcome pending/);
    });
  } finally {
    await project.cleanup();
  }
});

test("Stop hook blocks every replay of the first stop and records unknown only when stop_hook_active is true", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const route = await routeStage(routeInput({ contextId: "stop-session" }), { catalog: CATALOG, cwd: project.root });
      assert.equal(route.action, "delegate");
      const input = { cwd: project.root, session_id: "stop-session", turn_id: "turn", stop_hook_active: false, last_assistant_message: "secret output" };
      const first = runHook("stop", input, project.home);
      const replay = runHook("stop", input, project.home);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(JSON.parse(first.stdout).decision, "block");
      assert.equal(JSON.parse(replay.stdout).decision, "block");

      const storeBefore = new RouterStore();
      assert.equal(Number(storeBefore.db.prepare("SELECT count(*) AS count FROM outcomes").get().count), 0);
      assert.equal(Number(storeBefore.db.prepare("SELECT count(*) AS count FROM stop_observations").get().count), 1);
      storeBefore.close();

      const second = runHook("stop", { ...input, stop_hook_active: true }, project.home);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout, "");
      const storeAfter = new RouterStore();
      const outcome = storeAfter.db.prepare("SELECT status FROM outcomes WHERE route_id = ?").get(route.routeId);
      assert.equal(outcome.status, "unknown");
      storeAfter.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("Stop hook allows a route that already has a final outcome", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const route = await routeStage(routeInput({ contextId: "complete" }), { catalog: CATALOG, cwd: project.root, store });
      recordOutcome({
        routeId: route.routeId,
        contextId: "complete",
        status: "passed",
        gate: route.verificationGate,
        failureType: null,
        retries: 0,
        retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
        escalations: route.escalation.count,
        userCorrection: false,
      }, { store, cwd: project.root });
      store.close();
      const stopped = runHook("stop", { cwd: project.root, session_id: "complete", stop_hook_active: false }, project.home);
      assert.equal(stopped.status, 0);
      assert.equal(stopped.stdout, "");
    });
  } finally {
    await project.cleanup();
  }
});

test("hook storage errors fail open without leaking paths or input", async () => {
  const project = await temporaryProject();
  try {
    const blockedHome = join(project.root, "not-a-directory");
    await writeFile(blockedHome, "x");
    const secret = "sk-super-secret-value";
    const result = runHook("stop", {
      cwd: project.root,
      session_id: "broken",
      stop_hook_active: false,
      last_assistant_message: secret,
    }, blockedHome);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await project.cleanup();
  }
});
