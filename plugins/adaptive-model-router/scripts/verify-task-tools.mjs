#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexCommandSync, spawnSpec } from "./lib/codex-command.mjs";

const REQUIRED_TOOLS = Object.freeze(["diagnose_router", "route_stage"]);
const prompt = [
  "Use $adaptive-model-router for this read-only post-install smoke.",
  "Call diagnose_router exactly once with only the trusted contextId supplied by the Router hook.",
  "Then call route_stage exactly once for phase question and goal post-install tool exposure check,",
  "using the same trusted contextId, evidence workProduct=false, and delegation availability=false.",
  "Do not create a subagent, do not call record_outcome, and do not modify files.",
  "Return TASK_TOOL_SMOKE_OK only after both Router calls succeed.",
].join(" ");

function itemTool(item) {
  const value = typeof item?.tool === "string"
    ? item.tool
    : typeof item?.name === "string"
      ? item.name
      : "";
  return value.split("__").at(-1);
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error("Codex emitted a non-JSON event during task-tool smoke");
    }
  }
  return events;
}

function completedToolCalls(events, tool) {
  return events.filter((event) =>
    event?.type === "item.completed" &&
    itemTool(event.item) === tool &&
    !["failed", "error"].includes(event.item?.status),
  );
}

const project = mkdtempSync(join(tmpdir(), "adaptive-router-task-tools-"));
try {
  const codex = resolveCodexCommandSync();
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "-C",
    project,
    prompt,
  ];
  const spec = spawnSpec(codex, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: project,
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Codex disposable task failed; trust the current plugin Hooks and retry");
  }
  const events = parseEvents(result.stdout || "");
  const counts = Object.fromEntries(
    REQUIRED_TOOLS.map((tool) => [tool, completedToolCalls(events, tool).length]),
  );
  if (REQUIRED_TOOLS.some((tool) => counts[tool] !== 1)) {
    throw new Error(
      "TASK_TOOL_EXPOSURE_MISSING: a new Codex task did not complete exactly one diagnose_router and route_stage call",
    );
  }
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    taskToolExposure: true,
    verifiedTools: REQUIRED_TOOLS,
  })}\n`);
} catch (error) {
  process.stderr.write(`adaptive-model-router task-tool smoke: ${error?.message || "verification failed"}\n`);
  process.exitCode = 7;
} finally {
  rmSync(project, { recursive: true, force: true });
}
