function targetText(target) {
  return target ? `${target.model} (${target.effort})` : "none";
}

function rootText(rootTask, locale) {
  const observed = rootTask?.modelVisibility === "hook_observed" ? rootTask.model : null;
  if (locale === "zh") {
    return observed
      ? `${observed}（Codex 管理，路由器未改变；effort 仅在右下角可见）`
      : "由 Codex 主机管理（路由器未改变）";
  }
  return observed
    ? `${observed} (Codex-managed and unchanged; effort is visible only in the composer)`
    : "host-managed and unchanged by the router";
}

function taskModeText(status, locale) {
  if (locale === "zh") {
    if (status.taskMode === "pending_confirmation") return "等待确认根模型变化；仅使用根任务";
    if (status.taskMode === "manual_root") return "本任务手动；仅使用根任务";
    return "自动";
  }
  if (status.taskMode === "pending_confirmation") return "root-model change pending; root-only";
  if (status.taskMode === "manual_root") return "manual root-only for this task";
  return "automatic";
}

function transitionText(transition, locale) {
  const state = transition?.state || "not_delegated";
  if (locale === "zh") {
    if (state === "initial_delegate") return "首次委派";
    if (state === "target_changed") return `目标变化：${targetText(transition.from)} → ${targetText(transition.to)}`;
    if (state === "target_unchanged") return `目标未变：${targetText(transition.to)}`;
    return "未委派";
  }
  if (state === "initial_delegate") return "initial delegation";
  if (state === "target_changed") return `target changed: ${targetText(transition.from)} → ${targetText(transition.to)}`;
  if (state === "target_unchanged") return `target unchanged: ${targetText(transition.to)}`;
  return "not delegated";
}

function outcomeText(outcome, locale) {
  if (!outcome) return locale === "zh" ? "待记录" : "pending";
  return outcome.status;
}

function routeActionText(route, locale) {
  if (route.action === "delegate") {
    return locale === "zh"
      ? `委派目标 ${targetText(route.target)}`
      : `delegate target ${targetText(route.target)}`;
  }
  if (route.action === "ask_user") return locale === "zh" ? "等待用户决定" : "awaiting user decision";
  return locale === "zh" ? "由根任务继续" : "continue in root task";
}

export function formatRouteStatus(status, { locale = "en" } = {}) {
  const latest = status.latestRoute;
  if (locale === "zh") {
    const automatic = status.autoActivation.globalEnabled
      ? status.autoActivation.effective ? "已开启" : "已开启（当前范围暂停）"
      : "已关闭";
    const lines = [
      "[Adaptive Router 状态]",
      `全局自动：${automatic}；本任务模式：${taskModeText(status, "zh")}。`,
      `根任务模型：${rootText(status.rootTask, "zh")}。`,
    ];
    if (status.pendingHostModelChange) {
      lines.push(`待确认变化：${status.pendingHostModelChange.fromModel} → ${status.pendingHostModelChange.toModel} · ${status.pendingHostModelChange.changeId}`);
      lines.push("请选择“路由器：本任务手动”或“路由器：本任务自动”。");
    }
    if (!latest) lines.push("当前阶段：尚无路由记录。");
    else {
      lines.push(`当前阶段：${routeActionText(latest, "zh")}。`);
      lines.push(`最近路由：${latest.createdAt} · ${latest.routeId}`);
      lines.push(`变化：${transitionText(latest.transition, "zh")}。`);
      lines.push(`原因：${latest.reasonCodes.join(", ")}。`);
      lines.push(`结果：${outcomeText(latest.outcome, "zh")}。`);
    }
    lines.push(`待记录结果：${status.pendingOutcomes}；待审批策略：${status.pendingProposals}。`);
    lines.push("查看记录：发送“路由器：历史 10”。");
    return lines.join("\n");
  }
  const automatic = status.autoActivation.globalEnabled
    ? status.autoActivation.effective ? "on" : "on (paused in the current scope)"
    : "off";
  const lines = [
    "[Adaptive Router status]",
    `Global automatic activation: ${automatic}; task mode: ${taskModeText(status, "en")}.`,
    `Root-task model: ${rootText(status.rootTask, "en")}.`,
  ];
  if (status.pendingHostModelChange) {
    lines.push(`Pending change: ${status.pendingHostModelChange.fromModel} → ${status.pendingHostModelChange.toModel} · ${status.pendingHostModelChange.changeId}`);
    lines.push('Choose "router: manual" or "router: auto session".');
  }
  if (!latest) lines.push("Current stage: no route has been recorded.");
  else {
    lines.push(`Current stage: ${routeActionText(latest, "en")}.`);
    lines.push(`Latest route: ${latest.createdAt} · ${latest.routeId}`);
    lines.push(`Transition: ${transitionText(latest.transition, "en")}.`);
    lines.push(`Reasons: ${latest.reasonCodes.join(", ")}.`);
    lines.push(`Outcome: ${outcomeText(latest.outcome, "en")}.`);
  }
  lines.push(`Pending outcomes: ${status.pendingOutcomes}; pending policy proposals: ${status.pendingProposals}.`);
  lines.push('View records: send "router: history 10".');
  return lines.join("\n");
}

export function formatRouteHistory(history, { locale = "en" } = {}) {
  const routes = history.routes || [];
  if (locale === "zh") {
    const lines = [
      `[Adaptive Router 历史 · 最近 ${routes.length} 条]`,
      `当前根任务模型：${rootText(history.rootTask, "zh")}。下列记录是阶段路由/委派决定，不是根模型热切换。`,
    ];
    if (!routes.length) lines.push("当前项目与任务中尚无路由记录。");
    for (const route of routes) {
      lines.push([
        route.createdAt,
        `根任务 ${rootText(route.rootTask, "zh")}`,
        routeActionText(route, "zh"),
        transitionText(route.transition, "zh"),
        `结果 ${outcomeText(route.outcome, "zh")}`,
        `routeId ${route.routeId}`,
        `原因 ${route.reasonCodes.join(", ")}`,
      ].join(" · "));
    }
    return lines.join("\n");
  }
  const lines = [
    `[Adaptive Router history · latest ${routes.length}]`,
    `Current root-task model: ${rootText(history.rootTask, "en")}. These are stage routing/delegation decisions, not root-model hot switches.`,
  ];
  if (!routes.length) lines.push("No routes have been recorded for this project and task.");
  for (const route of routes) {
    lines.push([
      route.createdAt,
      `root ${rootText(route.rootTask, "en")}`,
      routeActionText(route, "en"),
      transitionText(route.transition, "en"),
      `outcome ${outcomeText(route.outcome, "en")}`,
      `routeId ${route.routeId}`,
      `reasons ${route.reasonCodes.join(", ")}`,
    ].join(" · "));
  }
  return lines.join("\n");
}
