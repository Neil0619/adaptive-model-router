const PREFIX = "Adaptive Model Router diagnostic ";

const ERROR_CATEGORIES = new Map([
  ["SQLITE_BUSY", "sqlite_busy"],
  ["SQLITE_LOCKED", "sqlite_busy"],
  ["SQLITE_READONLY", "sqlite_readonly"],
  ["EACCES", "state_dir_unwritable"],
  ["EPERM", "state_dir_unwritable"],
  ["EROFS", "state_dir_unwritable"],
  ["ENOTDIR", "state_dir_unwritable"],
  ["EISDIR", "state_dir_unwritable"],
  ["EEXIST", "state_dir_unwritable"],
]);

function stateRootSource(env) {
  if (env.ADAPTIVE_ROUTER_HOME) return "adaptive_override";
  if (env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA) return "plugin_data";
  return "codex_home";
}

export function classifyDiagnosticError(error, fallback = "unknown") {
  if (error instanceof SyntaxError) return "invalid_input";
  const code = typeof error?.code === "string" ? error.code : "";
  if (ERROR_CATEGORIES.has(code)) return ERROR_CATEGORIES.get(code);
  const message = typeof error?.message === "string" ? error.message : "";
  if (/\b(?:SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy)\b/i.test(message)) return "sqlite_busy";
  if (/\b(?:SQLITE_READONLY|attempt to write a readonly database)\b/i.test(message)) return "sqlite_readonly";
  return fallback;
}

export function emitDiagnostic({ component, stage, error, category, startedAt = Date.now(), env = process.env, stderr = process.stderr }) {
  if (env.ADAPTIVE_ROUTER_DIAGNOSTICS !== "1") return;
  const elapsedMs = Math.max(0, Math.floor(Date.now() - startedAt));
  const payload = {
    component,
    stage,
    category: category || classifyDiagnosticError(error),
    nodeMajor: Number.parseInt(process.versions.node, 10) || 0,
    pluginData: env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA ? "present" : "absent",
    stateRootSource: stateRootSource(env),
    elapsedMs,
  };
  stderr.write(`${PREFIX}${JSON.stringify(payload)}\n`);
}
