import { payloadHash } from "./io.mjs";
import { forwardedToolCall, forwardedToolResult } from "./code-mode-tool-evidence.mjs";

// Epoch adoption changes a Router interpreter, not the root's business state.
// A native terminal code cell proves its interpreter has returned, including
// when the script failed. Its opaque/external business effects remain retained
// obligations; they are never turned into successful outcomes or child closure.
// Known live cells, native commands and process handles must still be terminal.
// Do not use this projection in child verification or reservation reclamation.
export class RootEpochOperations {
  constructor(contextId) {
    this.contextId = contextId;
    this.returned = new Map(); this.cells = new Map(); this.starts = []; this.ends = [];
  }

  observe(entry, operations) {
    const p = entry.payload;
    if (entry.type === "event_msg" && p?.type === "item_completed") {
      const item = p.item, command = item?.command;
      if (p.thread_id === this.contextId && p.turn_id && item?.type === "CommandExecution"
        && item.source === "unified_exec_startup" && ["completed", "failed"].includes(item.status)
        && Number.isSafeInteger(item.exit_code) && typeof item.id === "string"
        && item.process_id != null && Array.isArray(command) && command.length === 3
        && /(?:^|[\\/])(?:ba|z|da|k)?sh(?:\.exe)?$/u.test(command[0]) && /^-[il]*c$/u.test(command[1])
        && typeof command[2] === "string") {
        this.ends.push({ callId: item.id, turnId: p.turn_id, id: String(item.process_id),
          commandDigest: payloadHash(command[2]), order: operations.order, status: item.status, exitCode: item.exit_code });
      }
    }
    if (entry.type !== "response_item" || !["function_call_output", "custom_tool_call_output"].includes(p?.type) || !p.call_id) return;
    const call = operations.calls.get(p.call_id);
    if (!call || call.namespace && call.namespace !== "functions" || !["exec", "wait"].includes(call.name)) return;
    const header = Array.isArray(p.output) && p.output[0]?.type === "input_text" ? p.output[0].text : p.output;
    if (typeof header !== "string") return;
    let args; try { args = JSON.parse(call.arguments || "{}"); } catch { return; }
    const running = /^Script running with cell ID ([A-Za-z0-9_-]+)(?:\n|$)/u.exec(header);
    if (call.name === "exec" && running) this.cells.set(running[1], call.call_id);
    const owner = call.name === "exec" ? call.call_id : this.cells.get(String(args.cell_id));
    if (!owner) return;
    const terminal = /^Script (completed|failed|terminated)(?:\n|$)/u.exec(header);
    if (terminal) {
      this.returned.set(owner, { callId: owner, turnId: operations.calls.get(owner).observedTurnId,
        nativeResultDigest: payloadHash(p), interpreterState: terminal[1], businessState: "unverified_preserved" });
      if (call.name === "wait") {
        this.cells.delete(String(args.cell_id));
        if (operations.active.get(`cell:${args.cell_id}`)?.callId === owner) operations.active.delete(`cell:${args.cell_id}`);
      }
    }
    if (call.name === "exec") {
      const forwarded = forwardedToolCall(call.input ?? args.input ?? args.code);
      const result = forwarded && forwardedToolResult(Array.isArray(p.output) ? p.output.slice(1) : []);
      if (forwarded?.name === "exec_command" && typeof forwarded.args.cmd === "string" && result?.state === "running")
        this.starts.push({ id: result.id, turnId: call.observedTurnId, commandDigest: payloadHash(forwarded.args.cmd),
          callId: call.call_id, order: call.observedOrder });
    }
  }

  reconcile(operations) {
    const retained = [];
    for (const [key, op] of operations.active) {
      if (op.transport === "legacy_code_mode" && op.state === "execution_coverage_unknown"
        && this.returned.has(op.callId) && !operations.unanswered.has(op.callId)) {
        retained.push(this.returned.get(op.callId)); operations.active.delete(key);
      }
      if (op.kind !== "process") continue;
      const original = operations.calls.get(op.callId);
      let argumentsValue; try { argumentsValue = JSON.parse(original?.arguments || "{}"); } catch { argumentsValue = {}; }
      const poll = original && forwardedToolCall(original.input ?? argumentsValue.input ?? argumentsValue.code);
      if (!op.commandDigest && poll?.name === "write_stdin" && String(poll.args.session_id) === op.id
        && (poll.args.chars == null || poll.args.chars === "") && this.returned.has(op.callId)) {
        const ends = this.ends.filter((e) => e.id === op.id && e.turnId === op.turnId);
        if (ends.length === 1 && ends[0].order > original.observedOrder && !operations.commandEndConflicts.has(ends[0].callId)) {
          retained.push({ callId: op.callId, turnId: op.turnId, nativeTerminalDigest: payloadHash(ends[0]),
            interpreterState: "native_polled_process_returned", exitCode: ends[0].exitCode, businessState: "unverified_preserved" });
          operations.active.delete(key);
        }
        continue;
      }
      if (!op.commandDigest) continue;
      const starts = this.starts.filter((s) => s.id === op.id && s.turnId === op.turnId && s.commandDigest === op.commandDigest);
      const ends = this.ends.filter((e) => e.id === op.id && e.turnId === op.turnId && e.commandDigest === op.commandDigest);
      // Legacy native terminal items predate the Hook command ledger. Require
      // exact thread, turn, handle, shell command and one unambiguous owner.
      // A reused handle, changed command or caller-printed JSON grants nothing.
      if (starts.length === 1 && starts[0].callId === op.callId && ends.length === 1
        && ends[0].order > starts[0].order && !operations.commandEndConflicts.has(ends[0].callId)) {
        retained.push({ ...starts[0], nativeTerminalDigest: payloadHash(ends[0]), interpreterState: "native_process_returned",
          exitCode: ends[0].exitCode, businessState: "unverified_preserved" });
        operations.active.delete(key);
      }
    }
    return retained;
  }
}
