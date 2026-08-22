import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { defaultPluginData } from "./plugin-data.mjs";

function root(env) {
  return env.ADAPTIVE_ROUTER_HOME || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || defaultPluginData(env);
}

function pathFor(env) {
  return join(root(env), "diagnostics", "hook-identity-v1.json");
}

export function recordHookIdentityDiagnostic(audit, contextInjection, env = process.env) {
  const path = pathFor(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = {
    ...audit,
    contextInjection,
    observedAt: new Date().toISOString(),
  };
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return value;
}

export function readHookIdentityDiagnostic(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(pathFor(env), "utf8"));
    return {
      available: true,
      reasonCode: value.identityStatus === "missing_session_id"
        ? "HOOK_DISPATCHED_MISSING_SESSION_ID"
        : "HOOK_DISPATCHED_IDENTITY_ACCEPTED",
      lastObservation: value,
    };
  } catch {
    return {
      available: false,
      reasonCode: "HOOK_DISPATCH_NOT_OBSERVED",
      lastObservation: null,
    };
  }
}
