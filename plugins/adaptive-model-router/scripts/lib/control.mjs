import { EFFORT_ORDER } from "./constants.mjs";

export const READ_ONLY_INSPECTION_TOOLS = Object.freeze([
  "get_route_status",
  "get_route_history",
  "list_policy_proposals",
  "get_learning_status",
  "get_model_policy",
  "preview_model_policy",
  "diagnose_router",
  "shadow_route_stage",
]);

const READ_ONLY_TOOL_PATTERN = new RegExp(
  `(?:^|[^A-Za-z0-9_])(${READ_ONLY_INSPECTION_TOOLS.join("|")})(?=$|[^A-Za-z0-9_])`,
  "gu",
);
const DIRECT_READ_ONLY_INSPECTION_PATTERN = new RegExp(
  `^(?:(?:please\\s+)?(?:call|invoke|run|use|get|show|inspect)\\s+(?:the\\s+)?`
  + `|(?:请)?(?:调用|运行|使用|查看|获取|显示|检查)\\s*)`
  + `(?:${READ_ONLY_INSPECTION_TOOLS.join("|")})(?=$|[^A-Za-z0-9_])`,
  "iu",
);

const SCOPE_MAP = {
  once: "once",
  session: "session",
  project: "project",
  global: "global",
  all: "all",
  一次: "once",
  会话: "session",
  项目: "project",
  全局: "global",
  全部: "all",
};

export function controlText(prompt) {
  if (prompt.startsWith("router:")) return prompt.slice("router:".length).trim();
  if (prompt.startsWith("路由器：")) return prompt.slice("路由器：".length).trim();
  return null;
}

export function parseControl(text) {
  const normalized = String(text || "").trim();
  if (["全局开启", "全局启用"].includes(normalized)) return { command: "global_enable" };
  if (["全局关闭", "全局禁用"].includes(normalized)) return { command: "global_disable" };
  if (["本任务手动", "手动"].includes(normalized)) return { command: "manual" };
  if (["本任务自动", "保持自动", "恢复自动"].includes(normalized)) return { command: "auto", scope: "session" };
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const command = String(tokens.shift() || "").toLowerCase();
  if (command === "global" && tokens.length === 1) {
    if (["on", "enable"].includes(tokens[0].toLowerCase())) return { command: "global_enable" };
    if (["off", "disable"].includes(tokens[0].toLowerCase())) return { command: "global_disable" };
  }
  if (command === "manual" && tokens.length === 0) return { command: "manual" };
  if (["on", "enable", "启用", "开启"].includes(command) && tokens.length === 0) return { command: "enable" };
  if (["off", "disable", "禁用", "关闭"].includes(command) && tokens.length === 0) return { command: "disable" };
  if (["auto", "clear", "自动", "清除"].includes(command) && tokens.length <= 1) {
    if (tokens[0] && !SCOPE_MAP[tokens[0]]) return null;
    return { command: "auto", scope: SCOPE_MAP[tokens[0]] || "all" };
  }
  if (["status", "状态"].includes(command) && tokens.length === 0) return { command: "status" };
  if (["history", "历史", "记录"].includes(command) && tokens.length <= 1) {
    const limit = tokens.length ? Number(tokens[0]) : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return null;
    return { command: "history", limit };
  }
  if (["lock", "锁定"].includes(command)) {
    const model = tokens.shift();
    if (!model) return null;
    let effort = null;
    let scope = "session";
    for (const token of tokens) {
      if (EFFORT_ORDER.includes(token) && effort == null) effort = token;
      else if (SCOPE_MAP[token] && SCOPE_MAP[token] !== "all") scope = SCOPE_MAP[token];
      else return null;
    }
    return { command: "lock", model, effort, scope };
  }
  return null;
}

export function parseControlPrompt(prompt) {
  const text = controlText(String(prompt || ""));
  return text == null ? null : parseControl(text);
}

export function parseReadOnlyInspectionPrompt(prompt) {
  const text = String(prompt || "").trimStart();
  if (!text || /^(?:```|~~~|>)/u.test(text)) return null;
  const tools = [...text.matchAll(READ_ONLY_TOOL_PATTERN)].map((match) => match[1]);
  if (!tools.length) return null;
  const declaresInspection =
    /^this is (?:a )?read-only router inspection\b/iu.test(text)
    || /^这是(?:一次)?只读路由器检查/u.test(text);
  const directlyRequestsInspection = DIRECT_READ_ONLY_INSPECTION_PATTERN.test(text);
  if (!declaresInspection && !directlyRequestsInspection) return null;
  return { tools: [...new Set(tools)] };
}
