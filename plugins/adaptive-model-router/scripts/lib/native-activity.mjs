// Ordering is advisory; native idle, input and operation proof is checked separately.
// Classify actual tool identities, never keywords in user prompts or tool bodies.
const routerInspection = new Set(["get_route_status", "get_route_history", "diagnose_router",
  "list_policy_proposals", "get_learning_status", "get_model_policy", "preview_model_policy", "shadow_route_stage",
  "manage_stage", "record_outcome"]);
const collaborationInspection = new Set(["list_agents", "wait_agent", "interrupt_agent"]);
function inspection(server, tool) {
  return (["adaptive-model-router", "adaptive_model_router"].includes(server) && routerInspection.has(tool))
    || (server === "collaboration" && collaborationInspection.has(tool));
}
export class NativeActivity {
  constructor({ maintenanceCalls = new Set(), maintenanceInputOffset = Infinity } = {}) {
    this.maintenanceCalls = maintenanceCalls;
    this.maintenanceInputOffset = maintenanceInputOffset;
    this.inputs = 0;
    this.maintenance = false;
    this.lastActivity = null;
    this.turn = this.newTurn(null);
  }
  newTurn(id) { return { id, stamp: null, tools: 0, business: false }; }
  flush() {
    const t = this.turn;
    if ((t.business || (!this.maintenance && !t.tools)) && t.stamp !== null) {
      this.lastActivity = Math.max(this.lastActivity || 0, t.stamp);
    }
  }
  tool(server, name, callId, wrapper = false) {
    // Code-mode execution has no filesystem/network surface of its own. Its
    // native inner tools determine activity; an opaque turn still counts below.
    if (wrapper) return;
    this.turn.tools++;
    if (!inspection(server, name)
      && !this.maintenanceCalls.has(JSON.stringify([this.turn.id, callId]))) this.turn.business = true;
  }
  observe(entry) {
    const p = entry.payload;
    const next = entry.type === "event_msg" && p?.type === "task_started" ? p.turn_id
      : entry.type === "turn_context" ? p?.turn_id : null;
    if (next && next !== this.turn.id) { this.flush(); this.turn = this.newTurn(next); }
    if (entry.type === "response_item" && p?.type === "agent_message") {
      if (this.inputs++ === this.maintenanceInputOffset) {
        if (this.turn.completed) this.flush();
        this.turn = this.newTurn(this.turn.id); this.maintenance = true;
      }
    }
    if (entry.type === "event_msg" && ["item_started", "item_completed"].includes(p?.type)) {
      const item = p.item;
      if (item?.type === "McpToolCall") this.tool(item.server, item.tool, item.id);
      else if (["CommandExecution", "FileChange"].includes(item?.type)) this.tool("native", item.type, item.id);
    }
    if (entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(p?.type)) {
      const name = p.name || "", native = /^mcp__(.+)__(\w+)$/u.exec(name);
      const server = native?.[1] || p.namespace || "";
      const tool = native?.[2] || name;
      this.tool(server, tool, p.call_id, server === "functions" && ["exec", "wait"].includes(tool));
    }
    if ((entry.type === "event_msg" && ["task_started", "task_complete", "item_started", "item_completed"].includes(p?.type))
      || (entry.type === "response_item" && ["agent_message", "message", "function_call", "custom_tool_call"].includes(p?.type))) {
      const stamp = Date.parse(entry.timestamp);
      if (Number.isFinite(stamp)) this.turn.stamp = Math.max(this.turn.stamp || 0, stamp);
    }
    if (entry.type === "event_msg" && p?.type === "task_complete") this.turn.completed = true;
  }
  result() { this.flush(); return this.lastActivity; }
}
