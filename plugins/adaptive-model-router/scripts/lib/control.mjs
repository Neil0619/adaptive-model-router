import { EFFORT_ORDER } from "./constants.mjs";

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
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  const command = String(tokens.shift() || "").toLowerCase();
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
