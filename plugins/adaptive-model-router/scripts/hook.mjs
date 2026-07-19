#!/usr/bin/env node
import { parseControlPrompt } from "./lib/control.mjs";
import { writeJsonLine } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";

let RouterStore;

function readInput() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
      if (value.length > 1_000_000) reject(new Error("hook input is too large"));
    });
    process.stdin.on("end", () => resolve(JSON.parse(value || "{}")));
    process.stdin.on("error", reject);
  });
}

function additionalContext(message) {
  writeJsonLine(process.stdout, {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message },
  });
}

async function promptHook(input) {
  const control = parseControlPrompt(String(input.prompt || ""));
  if (!control) return;
  const contextId = String(input.session_id || input.turn_id || "");
  if (!contextId) return;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId });
    if (control.command === "status") {
      const status = store.status(context);
      additionalContext(`Adaptive routing status: enabled=${status.settings.enabled}, classifier=${status.settings.classifierMode}, pending outcomes=${status.pendingOutcomes}.`);
      return;
    }
    if (control.command === "enable") {
      store.configure(context, { enabled: true }, "project");
      store.clearOverrides(context, "session");
      additionalContext("Adaptive routing is enabled for this project.");
      return;
    }
    if (control.command === "disable") {
      store.setOverride(context, { scope: "session", mode: "disabled" });
      additionalContext("Adaptive routing is disabled for this session.");
      return;
    }
    if (control.command === "auto") {
      store.clearOverrides(context, control.scope);
      additionalContext(`Adaptive routing override cleared for scope ${control.scope}.`);
      return;
    }
    if (control.command === "lock") {
      if (control.scope === "global" && !store.getSettings(context).allowGlobalOverride) return;
      store.setOverride(context, {
        scope: control.scope,
        model: control.model,
        effort: control.effort,
      });
      additionalContext(`Adaptive routing lock set for scope ${control.scope}.`);
    }
  } finally {
    store.close();
  }
}

async function stopHook(input) {
  const contextId = String(input.session_id || input.turn_id || "");
  if (!contextId) return;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId });
    const result = store.handleStop(context, input.stop_hook_active === true);
    if (result.action === "block") {
      writeJsonLine(process.stdout, {
        decision: "block",
        reason: "Call record_outcome for each pending Adaptive Model Router delegated stage, then finish the task.",
      });
    }
  } finally {
    store.close();
  }
}

try {
  assertRuntime();
  ({ RouterStore } = await import("./lib/database.mjs"));
  const input = await readInput();
  if (process.argv[2] === "prompt") await promptHook(input);
  else if (process.argv[2] === "stop") await stopHook(input);
} catch {
  process.stderr.write("Adaptive Model Router hook failed safely.\n");
  process.exitCode = 0;
}
