import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
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

test("only exact complete control prefixes and known commands parse", () => {
  assert.deepEqual(parseControlPrompt("router: off"), { command: "disable" });
  assert.deepEqual(parseControlPrompt("router: history 5"), { command: "history", limit: 5 });
  assert.deepEqual(parseControlPrompt("路由器：历史"), { command: "history", limit: 10 });
  assert.deepEqual(parseControlPrompt("路由器：记录 20"), { command: "history", limit: 20 });
  assert.deepEqual(parseControlPrompt("路由器：锁定 gpt-5.6-sol high 一次"), {
    command: "lock", model: "gpt-5.6-sol", effort: "high", scope: "once",
  });
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

test("status and history controls visibly separate the root model from bounded stage targets", async () => {
  const project = await temporaryProject("adaptive visible Unicode 展示 ");
  try {
    await withRouterEnvironment(project, async () => {
      const contextId = "visible-session";
      const store = new RouterStore();
      const route = await routeStage(routeInput({
        contextId,
        override: { model: "gpt-5.6-sol", effort: "high" },
      }), { catalog: CATALOG, cwd: project.root, store });
      store.close();

      const statusResult = runHook("prompt", {
        cwd: project.root,
        session_id: contextId,
        prompt: "路由器：状态",
      }, project.home);
      assert.equal(statusResult.status, 0, statusResult.stderr);
      const status = JSON.parse(statusResult.stdout).hookSpecificOutput.additionalContext;
      assert.match(status, /根任务模型：由 Codex 主机管理；路由器从未切换根任务模型/);
      assert.match(status, /委派目标 gpt-5\.6-sol \(high\)/);
      assert.match(status, new RegExp(route.routeId));
      assert.match(status, /路由器：历史 10/);
      assert.match(status, /\d{4}-\d{2}-\d{2}T/);
      assert.doesNotMatch(status, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const historyResult = runHook("prompt", {
        cwd: project.root,
        session_id: contextId,
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
        prompt: "router: history 1",
      }, project.home);
      assert.equal(englishResult.status, 0, englishResult.stderr);
      const english = JSON.parse(englishResult.stdout).hookSpecificOutput.additionalContext;
      assert.match(english, /root-task model remains host-managed/i);
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
