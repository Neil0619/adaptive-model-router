function targetText(target) {
  return target ? `${target.model} (${target.effort})` : "none";
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
    const lines = [
      "[Adaptive Router 状态]",
      "根任务模型：由 Codex 主机管理；路由器从未切换根任务模型。",
    ];
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
  const lines = [
    "[Adaptive Router status]",
    "Root-task model: host-managed; the router never switches the root-task model.",
  ];
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
      "根任务模型始终由 Codex 主机管理；下列记录是阶段路由/委派决定，不是根模型热切换。",
    ];
    if (!routes.length) lines.push("当前项目与任务中尚无路由记录。");
    for (const route of routes) {
      lines.push([
        route.createdAt,
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
    "The root-task model remains host-managed. These are stage routing/delegation decisions, not root-model hot switches.",
  ];
  if (!routes.length) lines.push("No routes have been recorded for this project and task.");
  for (const route of routes) {
    lines.push([
      route.createdAt,
      routeActionText(route, "en"),
      transitionText(route.transition, "en"),
      `outcome ${outcomeText(route.outcome, "en")}`,
      `routeId ${route.routeId}`,
      `reasons ${route.reasonCodes.join(", ")}`,
    ].join(" · "));
  }
  return lines.join("\n");
}
