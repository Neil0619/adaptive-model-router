import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../../scripts/lib/database.mjs";
import { routeStage } from "../../scripts/lib/router.mjs";
import { callRouterTool } from "../../scripts/lib/service.mjs";
import { consumeDelegationTicket, observeAgentResult, claimDelegationSubagent, observeSubagentStop } from "../../scripts/lib/delegation-gate.mjs";
import { observeQualificationHook, qualificationReadiness, readTaskQualification, runtimeSourceDigest } from "../../scripts/lib/lifecycle-qualification.mjs";
import { payloadHash } from "../../scripts/lib/io.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "../fixtures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const call = (id, name, args) => ({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", call_id: id, name, arguments: JSON.stringify(args) } });
const output = (id, value) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: value } });

export async function historicalQualificationFixture(kind, run, existing = null) {
  const project = existing?.project || await temporaryProject("router-historical-qualification-");
  project.root = realpathSync(project.root); project.home = join(project.root, "state");
  const setup = async () => {
    const store = existing?.store || new RouterStore();
    try {
      const input = routeInput({ contextId: existing?.contextId || "historical-parent" }), context = store.context({ cwd: project.root, contextId: input.contextId });
      const binding = { digest: "a".repeat(64), runtimeDigest: runtimeSourceDigest(), configurationDigest: "d".repeat(64),
        taskCwdDigest: payloadHash(realpathSync(project.root)), shellRoots: [payloadHash(ROOT)], cliVersion: "0.153.0" };
      const route = await routeStage(input, { store, cwd: project.root, catalog: CATALOG,
        diskProbe: () => 16n * 1024n ** 3n, lifecycleHookProbe: async () => qualificationReadiness(store.db, context, binding) });
      const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message, model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
      store.transaction(() => {
        assert.equal(consumeDelegationTicket(store.db, context, { taskName: route.carrier.taskName, turnId: "root-turn", toolUseId: "spawn-call", toolInput }).allowed, true);
        observeAgentResult(store.db, context, { turnId: "root-turn", toolUseId: "spawn-call", toolInput, toolResponse: { task_name: route.carrier.taskName } });
        for (const event of ["pre", "post"]) observeQualificationHook(store.db, context, route.routeId, event, ROOT);
        if (kind === "completed") {
          claimDelegationSubagent(store.db, context, { taskName: route.carrier.taskName, agentId: "child", model: route.target.model });
          observeSubagentStop(store.db, context, route.carrier.taskName, "child", 4096);
          for (const event of ["start", "stop"]) observeQualificationHook(store.db, context, route.routeId, event, ROOT);
        }
      });
      if (kind === "completed") await callRouterTool("record_outcome", { contextId: input.contextId, routeId: route.routeId,
        status: "failed", gate: "structured-check", failureType: "environment", retries: 0,
        retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false }, { store, cwd: project.root });
      const q = readTaskQualification(store.db, context), agentPath = `/root/${route.carrier.taskName}`;
      const directory = join(project.root, "codex", "sessions"); mkdirSync(directory, { recursive: true });
      const activity = (kind, id) => ({ type: "subAgentActivity", kind, id, agentThreadId: "child", agentPath });
      const parent = { id: input.contextId, cwd: project.root, path: join(directory, "parent.jsonl"), parentThreadId: null,
        turns: [{ id: "root-turn", status: kind === "completed" ? "failed" : "interrupted", itemsView: "full", items: [activity("started", "spawn-call")] }] };
      const final = { type: "agentMessage", id: "final", phase: "final_answer", text: q.marker };
      const child = { id: "child", parentThreadId: parent.id, forkedFromId: null, cwd: project.root, path: join(directory, "child.jsonl"),
        model: kind === "completed" ? route.target.model : null, reasoningEffort: kind === "completed" ? route.target.effort : null,
        source: { subAgent: { thread_spawn: { parent_thread_id: parent.id, depth: 1, agent_path: agentPath } } },
        turns: [{ id: "child-first", status: kind === "completed" ? "failed" : "interrupted", error: kind === "completed" ? { message: "fixture failure" } : null, itemsView: "full", items: [] }] };
      const rootRecords = [...(existing?.parentPrefix || [{ type: "session_meta", payload: { id: parent.id, cwd: project.root } }]), event("task_started", { turn_id: "root-turn" }),
        call("spawn-call", "spawn_agent", toolInput), output("spawn-call", JSON.stringify({ task_name: agentPath }))];
      const childRecords = [{ type: "session_meta", payload: { id: child.id, session_id: parent.id, parent_thread_id: parent.id, cwd: project.root,
        agent_path: agentPath, source: { subagent: { thread_spawn: child.source.subAgent.thread_spawn } } } }, event("task_started", { turn_id: "child-first" })];
      if (kind === "completed") {
        parent.turns.push({ id: "root-next", status: "completed", itemsView: "full", items: [activity("interacted", "followup-call"), activity("completed", "subagent-completed-child-last")] });
        child.turns.push({ id: "child-last", status: "completed", error: null, itemsView: "full", items: [final] });
        rootRecords.push(event("task_complete", { turn_id: "root-turn", error: { message: "fixture" } }), event("task_started", { turn_id: "root-next" }),
          call("followup-call", "followup_task", { target: route.carrier.taskName, message: "Complete the same no-tool qualification" }), output("followup-call", ""), event("task_complete", { turn_id: "root-next" }));
        childRecords.push({ type: "turn_context", payload: { turn_id: "child-first", model: child.model, effort: child.reasoningEffort } },
          { type: "response_item", payload: { type: "agent_message", author: "/root", recipient: agentPath, content: "activation" } },
          event("task_complete", { turn_id: "child-first", error: child.turns[0].error }), event("task_started", { turn_id: "child-last" }),
          { type: "turn_context", payload: { turn_id: "child-last", model: child.model, effort: child.reasoningEffort } },
          { type: "response_item", payload: { type: "agent_message", author: "/root", recipient: agentPath, content: "followup" } },
          { type: "response_item", payload: { type: "message", role: "assistant", id: "final", phase: "final_answer", content: [{ type: "output_text", text: q.marker }] } },
          event("task_complete", { turn_id: "child-last", last_agent_message: q.marker }));
      } else {
        rootRecords.push(event("turn_aborted", { turn_id: "root-turn" }));
        childRecords.push({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "fixture" }] } }, event("turn_aborted", { turn_id: "child-first" }));
      }
      const write = () => { for (const [path, records] of [[parent.path, rootRecords], [child.path, childRecords]]) writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n"); };
      write();
      const options = { store, cwd: project.root, sourceGeneration: existing?.sourceGeneration,
        readThread: async (id) => structuredClone(id === parent.id ? parent : child) };
      await run({ store, project, context, q, route, binding, stageInput: input,
        routeOptions: { store, cwd: project.root, catalog: CATALOG, diskProbe: () => 16n * 1024n ** 3n,
          lifecycleHookProbe: async () => qualificationReadiness(store.db, context, binding) },
        input: { contextId: parent.id, routeId: route.routeId }, options, parent, child, rootRecords, childRecords, write });
    } finally { if (!existing) store.close(); }
  };
  try { if (existing) await setup(); else await withRouterEnvironment(project, setup); }
  finally { if (!existing) await project.cleanup(); }
}
