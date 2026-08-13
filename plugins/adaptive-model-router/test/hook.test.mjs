import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { parseControlPrompt, parseReadOnlyInspectionPrompt } from "../scripts/lib/control.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
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

test("only explicit direct read-only inspection requests activate the inspection guard", () => {
  assert.deepEqual(
    parseReadOnlyInspectionPrompt(
      "This is read-only router inspection, not a substantive work-product stage.\n"
      + "Call shadow_route_stage exactly once, then call get_learning_status.",
    ),
    { tools: ["shadow_route_stage", "get_learning_status"] },
  );
  assert.deepEqual(
    parseReadOnlyInspectionPrompt("请调用 shadow_route_stage，并查看 get_learning_status。"),
    { tools: ["shadow_route_stage", "get_learning_status"] },
  );
  assert.deepEqual(
    parseReadOnlyInspectionPrompt("Call list_policy_proposals for the current project."),
    { tools: ["list_policy_proposals"] },
  );
  assert.deepEqual(
    parseReadOnlyInspectionPrompt("Use diagnose_router for the current task."),
    { tools: ["diagnose_router"] },
  );
  for (const prompt of [
    "Discuss whether to call shadow_route_stage.",
    "Do not call shadow_route_stage.",
    "Please do not call shadow_route_stage.",
    "> Call shadow_route_stage.",
    "```\nCall shadow_route_stage.\n```",
    "Implement shadow_route_stage and add tests.",
    "Fix shadow_route_stage because it writes a route.",
    "The docs say: Call shadow_route_stage.",
    "不要调用 shadow_route_stage。",
    "Use the current host task ID as contextId. Call route_stage for implementation, "
      + "then call get_route_status, get_route_history, and diagnose_router.",
  ]) assert.equal(parseReadOnlyInspectionPrompt(prompt), null, prompt);
});

test("a substantive route lifecycle with trailing reports is not isolated as inspection", async () => {
  const project = await temporaryProject("adaptive inspection negative Unicode 自动 ");
  try {
    const base = {
      cwd: project.root,
      session_id: "substantive-session",
      model: "gpt-5.6-luna",
    };
    const enabled = runHook("prompt", { ...base, prompt: "router: global on" }, project.home);
    assert.equal(enabled.status, 0, enabled.stderr);
    const substantive = runHook("prompt", {
      ...base,
      prompt: "Use the current host task ID as contextId. Call route_stage for implementation, "
        + "then call record_outcome, get_route_status, get_route_history, and diagnose_router.",
    }, project.home);
    assert.equal(substantive.status, 0, substantive.stderr);
    const context = JSON.parse(substantive.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /global automatic activation is enabled/);
    assert.doesNotMatch(context, /Read-only router inspection is active/);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const identity = store.context({
          cwd: project.root,
          contextId: base.session_id,
          authoritative: true,
        });
        assert.equal(store.inspectionGuardActive(identity), false);
      } finally {
        store.close();
      }
    });
  } finally {
    project.cleanup();
  }
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
    assert.match(
      firstContext,
      /action=delegate.*explicit request from the applicable adaptive-model-router skill/i,
    );
    assert.match(
      firstContext,
      /required, not a suggestion.*exactly one bounded subagent/i,
    );
    assert.match(firstContext, /Only an actual host-tool rejection/i);
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
    assert.doesNotMatch(changedContext, /required, not a suggestion/i);
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
    assert.doesNotMatch(manualTurn.stdout, /required, not a suggestion/i);
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

test("bounded subagent hooks never recurse into routing or mutate root-task state", async () => {
  const project = await temporaryProject("adaptive bounded subagent 隔离 ");
  try {
    const root = {
      cwd: project.root,
      session_id: "parent-session",
      model: "gpt-5.6-luna",
    };
    assert.equal(
      runHook("prompt", { ...root, prompt: "router: global on" }, project.home).status,
      0,
    );
    assert.equal(
      runHook("prompt", { ...root, prompt: "Implement the parent stage." }, project.home).status,
      0,
    );

    const child = {
      ...root,
      model: "gpt-5.6-terra",
    };
    const submitted = runHook("prompt", {
      ...child,
      agent_id: "agent-secret-identifier",
      prompt: "Implement only the delegated bounded stage.",
    }, project.home);
    assert.equal(submitted.status, 0, submitted.stderr);
    const submittedOutput = JSON.parse(submitted.stdout);
    assert.equal(
      submittedOutput.hookSpecificOutput.hookEventName,
      "UserPromptSubmit",
    );
    const boundedContext = submittedOutput.hookSpecificOutput.additionalContext;
    assert.match(boundedContext, /already a bounded subagent/i);
    assert.match(boundedContext, /never call route_stage/i);
    assert.doesNotMatch(boundedContext, /global automatic activation is enabled/i);
    assert.doesNotMatch(boundedContext, /unresolved active root-model change/i);
    assert.doesNotMatch(
      boundedContext,
      /agent-secret-identifier|worker-secret-type|gpt-5\.6-terra|Implement only/,
    );

    const started = runHook("subagent-start", {
      ...child,
      agent_id: "agent-secret-identifier",
      agent_type: "worker-secret-type",
      hook_event_name: "SubagentStart",
      turn_id: "child-turn",
    }, project.home);
    assert.equal(started.status, 0, started.stderr);
    const startedOutput = JSON.parse(started.stdout);
    assert.equal(
      startedOutput.hookSpecificOutput.hookEventName,
      "SubagentStart",
    );
    assert.match(startedOutput.hookSpecificOutput.additionalContext, /already a bounded subagent/i);
    assert.doesNotMatch(
      startedOutput.hookSpecificOutput.additionalContext,
      /agent-secret-identifier|worker-secret-type|gpt-5\.6-terra/,
    );

    const ignoredControl = runHook("prompt", {
      ...child,
      agent_type: "worker-secret-type",
      prompt: "router: manual",
    }, project.home);
    assert.equal(ignoredControl.status, 0, ignoredControl.stderr);
    assert.match(ignoredControl.stdout, /already a bounded subagent/i);
    assert.doesNotMatch(ignoredControl.stdout, /manual-root mode/i);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const context = store.context({
          cwd: project.root,
          contextId: root.session_id,
          authoritative: true,
        });
        const state = store.hostModelState(context);
        assert.equal(state.taskMode, "automatic");
        assert.equal(state.currentModel, "gpt-5.6-luna");
        assert.equal(state.pendingChange, null);
        assert.equal(
          Number(store.db.prepare("SELECT count(*) AS count FROM host_model_changes").get().count),
          0,
        );
        assert.equal(store.inspectionGuardActive(context), false);
        const route = await routeStage(routeInput({
          contextId: root.session_id,
          override: { model: "gpt-5.6-terra", effort: "low" },
        }), { catalog: CATALOG, cwd: project.root, store });
        assert.equal(route.action, "delegate");
      } finally {
        store.close();
      }
    });

    const stopped = runHook("stop", {
      ...child,
      agent_id: "agent-secret-identifier",
      hook_event_name: "Stop",
      stop_hook_active: false,
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, "");

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        assert.equal(
          Number(store.db.prepare("SELECT count(*) AS count FROM stop_observations").get().count),
          0,
        );
        assert.equal(
          Number(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count),
          0,
        );
      } finally {
        store.close();
      }
    });

    const resumedRoot = runHook("prompt", {
      ...root,
      prompt: "Verify the delegated result in the root task.",
    }, project.home);
    assert.equal(resumedRoot.status, 0, resumedRoot.stderr);
    assert.match(resumedRoot.stdout, /global automatic activation is enabled/);
    assert.doesNotMatch(resumedRoot.stdout, /unresolved active root-model change/);
  } finally {
    await project.cleanup();
  }
});

test("automatic routing treats shadow scoring as read-only and leaves Stop lifecycle untouched", async () => {
  const project = await temporaryProject("adaptive shadow hook ");
  try {
    const base = {
      cwd: project.root,
      session_id: "shadow-hook-session",
      model: "gpt-5.6-sol",
    };
    assert.equal(
      runHook("prompt", { ...base, prompt: "router: global on" }, project.home).status,
      0,
    );
    const prompt = "Call shadow_route_stage exactly once for a risk-sensitive review.";
    const submitted = runHook("prompt", { ...base, prompt }, project.home);
    assert.equal(submitted.status, 0, submitted.stderr);
    const context = JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Read-only router inspection/);
    assert.match(context, /Do not call route_stage before or after the inspection/);
    assert.doesNotMatch(context, new RegExp(prompt));

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const counts = () => Object.fromEntries(
        [
          "routes",
          "outcomes",
          "stop_observations",
          "learning_cursors",
          "policy_proposals",
          "policy_revisions",
          "scoring_profiles",
          "route_score_snapshots",
          "learning_events",
        ].map((table) => [
          table,
          Number(store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count),
        ]),
      );
      const before = counts();
      let firstError;
      await assert.rejects(
        callRouterTool("route_stage", routeInput({
          contextId: base.session_id,
          goal: "Score a risk-sensitive public contract review.",
          phase: "review",
          evidence: { workProduct: true, review: true, highRisk: true },
        }), { store, cwd: project.root, routeOptions: { catalog: CATALOG } }),
        (error) => {
          firstError = error;
          return /read-only router inspection/i.test(error.message);
        },
      );
      assert.doesNotMatch(firstError.message, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(firstError.message, new RegExp(base.session_id));
      await assert.rejects(
        callRouterTool("route_stage", routeInput({
          contextId: base.session_id,
          goal: "Try the live route a second time.",
          phase: "review",
          evidence: { workProduct: true, review: true, highRisk: true },
        }), { store, cwd: project.root, routeOptions: { catalog: CATALOG } }),
        /read-only router inspection/i,
      );
      assert.deepEqual(counts(), before);
      const shadow = await callRouterTool("shadow_route_stage", {
        contextId: base.session_id,
        goal: "Review a risk-sensitive public contract.",
        phase: "review",
        evidence: { workProduct: true, review: true, highRisk: true },
      }, { store, cwd: project.root });
      assert.equal(shadow.shadow, true);
      assert.equal(shadow.sideEffects, false);
      assert.deepEqual(shadow.stateCounts.before, shadow.stateCounts.after);
      assert.deepEqual(counts(), before);
      const meta = JSON.stringify(store.db.prepare("SELECT key, value FROM meta").all());
      assert.doesNotMatch(meta, new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(meta, new RegExp(base.session_id));
      assert.doesNotMatch(meta, new RegExp(prompt));
      store.close();
    });

    const stopped = runHook("stop", {
      ...base,
      stop_hook_active: false,
    }, project.home);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, "");
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      assert.equal(
        Number(store.db.prepare("SELECT count(*) AS count FROM stop_observations").get().count),
        0,
      );
      store.close();
    });

    const nextPrompt = runHook("prompt", {
      ...base,
      prompt: "Answer a simple question with no work product.",
    }, project.home);
    assert.equal(nextPrompt.status, 0, nextPrompt.stderr);
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const route = await callRouterTool("route_stage", routeInput({
        contextId: base.session_id,
        goal: "Answer a simple question.",
        phase: "answer",
        evidence: { workProduct: false },
      }), { store, cwd: project.root, routeOptions: { catalog: CATALOG } });
      assert.equal(route.action, "continue");
      assert.equal(store.inspectionGuardActive(
        store.context({ cwd: project.root, contextId: base.session_id }),
      ), false);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("proposal listing is guarded as read-only inspection", async () => {
  const project = await temporaryProject("adaptive proposal inspection ");
  try {
    const base = {
      cwd: project.root,
      session_id: "proposal-inspection",
      model: "gpt-5.6-sol",
    };
    assert.equal(
      runHook("prompt", { ...base, prompt: "router: global on" }, project.home).status,
      0,
    );
    const submitted = runHook("prompt", {
      ...base,
      prompt: "Call list_policy_proposals for the current project.",
    }, project.home);
    assert.equal(submitted.status, 0, submitted.stderr);
    const context = JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Read-only router inspection/);
    assert.match(context, /list_policy_proposals/);
    assert.doesNotMatch(context, /global automatic activation is enabled/);
    assert.doesNotMatch(context, /required, not a suggestion/i);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      await assert.rejects(
        callRouterTool("route_stage", routeInput({
          contextId: base.session_id,
          goal: "Do not create a live route before listing proposals.",
        }), { store, cwd: project.root, routeOptions: { catalog: CATALOG } }),
        /read-only router inspection/i,
      );
      const proposals = await callRouterTool("list_policy_proposals", {
        contextId: base.session_id,
      }, { store, cwd: project.root });
      assert.deepEqual(proposals, []);
      assert.equal(
        Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count),
        0,
      );
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("concurrent inspection hooks create one guard and never permit a live route", async () => {
  const project = await temporaryProject("adaptive inspection concurrent ");
  try {
    const base = {
      cwd: project.root,
      session_id: "parallel-inspection",
      model: "gpt-5.6-sol",
    };
    assert.equal(
      runHook("prompt", { ...base, prompt: "router: global on" }, project.home).status,
      0,
    );
    const prompts = await Promise.all(Array.from({ length: 20 }, () => runHookAsync("prompt", {
      ...base,
      prompt: "Call shadow_route_stage exactly once for a read-only review.",
    }, project.home)));
    assert.equal(prompts.every((result) => result.status === 0), true);

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      assert.equal(
        Number(store.db.prepare(
          "SELECT count(*) AS count FROM meta WHERE key LIKE 'inspection_guard:%'",
        ).get().count),
        1,
      );
      await assert.rejects(
        callRouterTool("route_stage", routeInput({
          contextId: base.session_id,
          goal: "Attempt a live route after concurrent inspection hooks.",
        }), { store, cwd: project.root, routeOptions: { catalog: CATALOG } }),
        /read-only router inspection/i,
      );
      assert.equal(
        Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count),
        0,
      );
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

test("hook-owned control turns forbid duplicate MCP calls and invented context IDs", async () => {
  const project = await temporaryProject("adaptive hook-owned controls 控制 ");
  try {
    const base = {
      cwd: project.root,
      session_id: "hook-owned-session",
      model: "gpt-5.6-sol",
    };
    for (const prompt of [
      "router: global on",
      "router: manual",
      "router: auto session",
      "router: lock gpt-5.6-terra low once",
      "router: off",
      "router: status",
      "router: history 1",
      "router: global off",
    ]) {
      const result = runHook("prompt", { ...base, prompt }, project.home);
      assert.equal(result.status, 0, result.stderr);
      const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(context, /already been applied atomically by the trusted UserPromptSubmit hook/i);
      assert.match(context, /do not call any Adaptive Model Router MCP tool/i);
      assert.match(context, /do not invent or substitute a contextId/i);
    }
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
    const ordinary = runHook(
      "prompt",
      { ...base, prompt: 'Explain why the quoted text "router: on" is not a control command.' },
      project.home,
    );
    assert.equal(ordinary.status, 0, ordinary.stderr);
    const ordinaryContext = JSON.parse(ordinary.stdout).hookSpecificOutput.additionalContext;
    assert.match(ordinaryContext, /disabled for this session/i);
    assert.doesNotMatch(ordinaryContext, /manual_root mode/i);

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

test("Stop hook finalizes every pending outcome as unknown without blocking the user reply", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const firstRoute = await routeStage(routeInput({ contextId: "stop-session" }), { catalog: CATALOG, cwd: project.root });
      const secondRoute = await routeStage(routeInput({
        contextId: "stop-session",
        goal: "Review the parser implementation and its targeted tests.",
        phase: "review",
        evidence: {
          workProduct: true,
          requirementsSettled: true,
          strongVerification: true,
          review: true,
        },
      }), { catalog: CATALOG, cwd: project.root });
      assert.equal(firstRoute.action, "delegate");
      assert.equal(secondRoute.action, "delegate");
      const input = {
        cwd: project.root,
        session_id: "stop-session",
        turn_id: "turn",
        stop_hook_active: false,
        last_assistant_message: `sk-stop-secret-value ${project.root}`,
      };
      const first = runHook("stop", input, project.home);
      const replay = runHook("stop", input, project.home);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, "");
      assert.equal(first.stderr, "");
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(replay.stdout, "");

      const storeBefore = new RouterStore();
      assert.deepEqual(
        storeBefore.db.prepare("SELECT route_id, status FROM outcomes ORDER BY route_id").all()
          .map((row) => ({ ...row })),
        [
          { route_id: firstRoute.routeId, status: "unknown" },
          { route_id: secondRoute.routeId, status: "unknown" },
        ].sort((left, right) => left.route_id.localeCompare(right.route_id)),
      );
      assert.equal(Number(storeBefore.db.prepare("SELECT count(*) AS count FROM stop_observations").get().count), 2);
      const stopContext = storeBefore.context({ cwd: project.root, contextId: "stop-session" });
      assert.equal(storeBefore.status(stopContext).outcomeObservability.stopHookUnknown, 2);
      assert.deepEqual(
        storeBefore.routeHistory(stopContext).routes.map((route) => route.outcome.source),
        ["stop_hook", "stop_hook"],
      );
      assert.doesNotMatch(
        JSON.stringify({
          routes: storeBefore.db.prepare("SELECT * FROM routes").all(),
          outcomes: storeBefore.db.prepare("SELECT * FROM outcomes").all(),
          stops: storeBefore.db.prepare("SELECT * FROM stop_observations").all(),
        }),
        /sk-stop-secret-value/,
      );
      assert.doesNotMatch(
        JSON.stringify({
          routes: storeBefore.db.prepare("SELECT * FROM routes").all(),
          outcomes: storeBefore.db.prepare("SELECT * FROM outcomes").all(),
          stops: storeBefore.db.prepare("SELECT * FROM stop_observations").all(),
        }),
        new RegExp(project.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      storeBefore.close();

      const second = runHook("stop", { ...input, stop_hook_active: true }, project.home);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout, "");
      const storeAfter = new RouterStore();
      assert.equal(Number(storeAfter.db.prepare("SELECT count(*) AS count FROM outcomes").get().count), 2);
      storeAfter.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("Stop hook resolves a legacy reminder while finalizing its pending outcome", async () => {
  const project = await temporaryProject();
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const route = await routeStage(routeInput({ contextId: "legacy-stop-session" }), {
        catalog: CATALOG,
        cwd: project.root,
        store,
      });
      const context = store.context({ cwd: project.root, contextId: "legacy-stop-session" });
      store.db.prepare(`
        INSERT INTO stop_observations(project_id, context_key, route_id, reminded_at)
        VALUES(?, ?, ?, ?)
      `).run(context.projectId, context.contextKey, route.routeId, new Date().toISOString());
      store.close();

      const stopped = runHook("stop", {
        cwd: project.root,
        session_id: "legacy-stop-session",
        stop_hook_active: false,
      }, project.home);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(stopped.stdout, "");

      const verified = new RouterStore();
      assert.equal(
        verified.db.prepare("SELECT status FROM outcomes WHERE route_id = ?").get(route.routeId).status,
        "unknown",
      );
      assert.notEqual(
        verified.db.prepare("SELECT resolved_at FROM stop_observations WHERE route_id = ?").get(route.routeId).resolved_at,
        null,
      );
      const legacyContext = verified.context({ cwd: project.root, contextId: "legacy-stop-session" });
      assert.equal(verified.routeHistory(legacyContext).routes[0].outcome.source, "stop_hook");
      verified.close();
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
      const context = store.context({ cwd: project.root, contextId: "complete" });
      store.db.prepare(`
        INSERT INTO stop_observations(project_id, context_key, route_id, reminded_at)
        VALUES(?, ?, ?, ?)
      `).run(context.projectId, context.contextKey, route.routeId, new Date().toISOString());
      store.close();
      const stopped = runHook("stop", { cwd: project.root, session_id: "complete", stop_hook_active: false }, project.home);
      assert.equal(stopped.status, 0);
      assert.equal(stopped.stdout, "");
      const verified = new RouterStore();
      assert.notEqual(
        verified.db.prepare("SELECT resolved_at FROM stop_observations WHERE route_id = ?").get(route.routeId).resolved_at,
        null,
      );
      const completeContext = verified.context({ cwd: project.root, contextId: "complete" });
      assert.equal(verified.routeHistory(completeContext).routes[0].outcome.source, "record_outcome");
      assert.equal(verified.status(completeContext).outcomeObservability.stopHookUnknown, 0);
      verified.close();
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
