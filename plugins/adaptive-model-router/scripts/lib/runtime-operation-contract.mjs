// Calls whose native execution or dispatch responsibility is interpreted by
// the epoch verifier. Unknown external actions never become no-work evidence.
export function knownOperationCall(item) {
  if (!["function_call", "custom_tool_call"].includes(item?.type)) return true;
  const native = !item.namespace || item.namespace === "functions";
  if (native && ["exec", "wait", "exec_command", "write_stdin", "apply_patch"].includes(item.name)) return true;
  if (native && item.name === "request_user_input_async") return true;
  if (item.namespace === "clock" && item.name === "sleep") return true;
  if ((!item.namespace || item.namespace === "collaboration")
    && ["spawn_agent", "followup_task", "send_message", "interrupt_agent", "list_agents", "wait_agent"].includes(item.name)) return true;
  return /^mcp__adaptive_model_router__(route_stage|record_outcome|manage_stage|get_route_status|get_route_history|get_model_policy|get_learning_status|diagnose_router)$/u.test(item.name || "");
}

// Root epoch continuation preserves external business as unverified; child
// closure and message checkpoints continue to use the narrower contract above.
export function knownRootOperationCall(item) {
  return knownOperationCall(item)
    || ((!item?.namespace || item.namespace === "functions") && item.name === "request_user_input")
    || (item?.namespace === "mcp__cua_repl" && item.name === "js");
}
