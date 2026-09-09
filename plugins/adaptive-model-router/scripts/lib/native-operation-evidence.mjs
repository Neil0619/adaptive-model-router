// Hook command records do not depend on JavaScript formatting. Native terminal
// events and exact legacy forwarding receipts can settle their own operations;
// arbitrary shell output or code-mode text() cannot settle work.
import { forwardedToolCall, forwardedToolResult, forwardedPollInput } from "./code-mode-tool-evidence.mjs";
import { payloadHash } from "./io.mjs";
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const firstText = (output) => typeof output === "string" ? output
  : Array.isArray(output) && output[0]?.type === "input_text" ? output[0].text : null;

export class NativeOperationEvidence {
  constructor({ childId = null, commands = [] } = {}) {
    this.calls = new Map(); this.unanswered = new Set(); this.active = new Map(); this.cells = new Map();
    this.childId = childId; this.currentTurnId = null;
    this.commandEnds = new Map(); this.commandEndConflicts = new Set();
    this.nativeStarts = new Map(); this.commandEndOrder = new Map(); this.order = 0;
    this.seenTurns = new Set();
    this.commands = new Map(commands.map((command) => [command.callId, command]));
    for (const command of commands) {
      if (command.conflicted || (command.started && !command.terminal)) {
        this.active.set(`command:${command.callId}`, { kind: "command", id: command.callId, callId: command.callId,
          transport: "native_command_hook", state: command.conflicted ? "conflicting_receipts" : "result_pending" });
      }
    }
  }

  recordCommandEnd(end) {
    const previous = this.commandEnds.get(end.callId);
    if (previous && payloadHash(previous) !== payloadHash(end)) this.commandEndConflicts.add(end.callId);
    if (this.commandEndConflicts.has(end.callId)) {
      this.active.set(`command:${end.callId}`, { kind: "command", id: end.callId, callId: end.callId,
        transport: "native_command_hook", state: "conflicting_receipts" });
    } else {
      this.commandEnds.set(end.callId, end);
      if (!this.commandEndOrder.has(end.callId)) this.commandEndOrder.set(end.callId, this.order);
      // A poll of opaque code-mode work may precede the first native handle
      // binding. Wait for every candidate captured at poll dispatch to end,
      // then require exactly one matching handle. Never replace a binding or
      // select between two generations that reused that handle.
      for (const [callId, call] of this.calls) {
        if (call.processOrigin || !call.pollId || !call.knownCommandIds?.length) continue;
        const candidates = call.pendingCommandIds.map((id) => this.commandEndConflicts.has(id) ? null : this.commandEnds.get(id));
        if (candidates.some((candidate) => !candidate)) continue;
        const matching = call.knownCommandIds.map((id) => this.commandEndConflicts.has(id) ? null : this.commandEnds.get(id))
          .filter((candidate) => candidate?.processId != null && String(candidate.processId) === call.pollId
          && call.observedOrder < this.commandEndOrder.get(candidate.callId));
        if (matching.length !== 1) continue;
        const [original] = matching;
        call.processOrigin = { kind: "process", id: call.pollId, callId: original.callId,
          turnId: original.turnId, transport: "native_command_hook" };
        if (this.active.get(`process:${call.pollId}`)?.callId === callId) {
          this.active.delete(`process:${call.pollId}`);
        }
      }
      this.active.delete(`command:${end.callId}`);
    }
  }

  observeCommandStart(payload) {
    const item = payload.item;
    if (!this.childId || payload.thread_id !== this.childId || typeof item?.id !== "string" || !payload.turn_id
      || !((item.type === "CommandExecution" && item.source === "unified_exec_startup") || item.type === "FileChange")
      || item.status !== "in_progress") return;
    const command = this.commands.get(item.id);
    if (command && (command.conflicted || command.turnId !== payload.turn_id)) return;
    const start = { callId: item.id, turnId: payload.turn_id, type: item.type,
      processId: item.process_id == null ? null : String(item.process_id) };
    const previous = this.nativeStarts.get(item.id);
    if (previous && payloadHash(previous) !== payloadHash(start)) {
      this.commandEndConflicts.add(item.id);
      this.active.set(`command:${item.id}`, { kind: "command", id: item.id, callId: item.id,
        transport: "native_event", state: "conflicting_receipts" });
      return;
    }
    this.nativeStarts.set(item.id, start);
    const end = this.commandEnds.get(item.id);
    if ((command?.terminal && !command.conflicted) || (end?.turnId === start.turnId && !this.commandEndConflicts.has(item.id))) return;
    this.active.set(`command:${item.id}`, { kind: "command", id: item.id, callId: item.id,
      turnId: payload.turn_id, processId: start.processId, transport: "native_event", state: "result_pending" });
  }

  processEnded(process) {
    return [...this.commandEnds.values()].some((end) => {
      if (this.commandEndConflicts.has(end.callId) || end.turnId !== process.turnId) return false;
      if (end.callId === process.callId) return end.processId == null || String(end.processId) === process.id;
      // A forwarded outer call has a different native inner call ID. Require
      // the exact handle, turn, command ledger and an outer call which preceded
      // this terminal; a later call can reuse the same command and handle.
      return end.processId != null && String(end.processId) === process.id
        && process.commandDigest && this.commands.get(end.callId)?.commandDigest === process.commandDigest
        && this.calls.get(process.callId)?.observedOrder < this.commandEndOrder.get(end.callId);
    });
  }

  rememberRunning(process) {
    process = this.calls.get(process.callId)?.processOrigin || process;
    if (!this.processEnded(process)) this.active.set(`process:${process.id}`, {
      ...process, ...this.active.get(`process:${process.id}`),
    });
  }

  finishPoll(callId, sessionId) {
    const key = `process:${sessionId}`;
    const process = this.active.get(key);
    if (!process) return;
    const original = this.calls.get(callId)?.processOrigin;
    if ((original && process.callId === original.callId && process.turnId === original.turnId)
      || process.callId === callId) this.active.delete(key);
    // A terminal for an earlier generation of this handle cannot stop its
    // newer owner. Without an original binding it proves only this poll ended.
  }

  observeCommandEnd(payload) {
    const item = payload.item;
    if (!this.childId || payload.thread_id !== this.childId || typeof item?.id !== "string" || !payload.turn_id) return;
    const command = this.commands.get(item.id);
    const matches = command?.started && !command.conflicted && command.turnId === payload.turn_id;
    const start = this.nativeStarts.get(item.id);
    const nativeMatch = start?.turnId === payload.turn_id && start.type === item.type
      && !this.commandEndConflicts.has(item.id);
    if (nativeMatch && item.type === "CommandExecution" && start.processId != null
      && item.process_id != null && start.processId !== String(item.process_id)) {
      this.commandEndConflicts.add(item.id);
      this.active.set(`command:${item.id}`, { kind: "command", id: item.id, callId: item.id,
        transport: "native_event", state: "conflicting_receipts" });
      return;
    }
    const direct = this.calls.get(item.id);
    const directMatch = direct?.name === "exec_command" && (!direct.namespace || direct.namespace === "functions")
      && direct.observedTurnId === payload.turn_id;
    if (item.type === "FileChange") {
      // exec_command can be handled by native apply_patch instead of starting a
      // shell. That path has no Bash Post, but emits this exact call's terminal
      // FileChange. Preserve its result, including failure or partial changes;
      // do not manufacture an exit code or a "never started" business outcome.
      if (!(matches || nativeMatch) || !["completed", "failed", "declined"].includes(item.status)
        || !item.changes || typeof item.changes !== "object" || Array.isArray(item.changes)
        || typeof item.stdout !== "string" || typeof item.stderr !== "string") return;
      this.recordCommandEnd({ callId: item.id, turnId: payload.turn_id, source: "native_file_change",
        status: item.status, resultDigest: payloadHash({ changes: item.changes, stdout: item.stdout, stderr: item.stderr }) });
      return;
    }
    if (item.type !== "CommandExecution" || item.source !== "unified_exec_startup"
      || !["completed", "failed"].includes(item.status) || !Number.isSafeInteger(item.exit_code)) return;
    if (matches || nativeMatch || (!command && directMatch)) this.recordCommandEnd({ callId: item.id, turnId: payload.turn_id, processId: item.process_id == null ? null : String(item.process_id),
      status: item.status, exitCode: item.exit_code });
    const process = this.active.get(`process:${item.process_id}`);
    if (process && this.processEnded(process)) this.active.delete(`process:${item.process_id}`);
  }

  observeForwarded(forwarded, blocks, callId) {
    const result = forwarded && forwardedToolResult(blocks);
    const call = this.calls.get(callId);
    if (!result && !call?.commandCoverage) {
      this.active.set(`unknown:${callId}`, { kind: "unknown", id: callId, callId,
        turnId: call?.observedTurnId, transport: "legacy_code_mode", state: "execution_coverage_unknown" });
    }
    if (result) this.active.delete(`unknown:${callId}`);
    if (result?.state === "running") this.rememberRunning({ kind: "process", id: result.id,
      callId, turnId: call?.observedTurnId, transport: "code_mode_forwarded",
      ...(forwarded.name === "exec_command" && typeof forwarded.args.cmd === "string" ? { commandDigest: payloadHash(forwarded.args.cmd) } : {}) });
    if (result?.state === "terminal" && forwarded.name === "write_stdin" && forwarded.args.session_id != null) {
      this.finishPoll(callId, forwarded.args.session_id);
    }
  }

  observe(entry, { commandCoverage = false } = {}) {
    this.order += 1;
    if (entry.type === "turn_context") this.currentTurnId = entry.payload?.turn_id || this.currentTurnId;
    if (entry.type === "event_msg" && entry.payload?.type === "task_started") this.currentTurnId = entry.payload.turn_id;
    if (this.currentTurnId) this.seenTurns.add(this.currentTurnId);
    if (entry.type === "event_msg" && entry.payload?.type === "item_started") this.observeCommandStart(entry.payload);
    if (entry.type === "event_msg" && entry.payload?.type === "item_completed") this.observeCommandEnd(entry.payload);
    if (entry.type !== "response_item") return;
    const item = entry.payload;
    if (["function_call", "custom_tool_call"].includes(item?.type)) {
      const args = parse(item.arguments);
      const forwarded = (!item.namespace || item.namespace === "functions") && item.name === "exec"
        ? forwardedToolCall(item.input ?? args?.input ?? args?.code) : null;
      const pollId = (!item.namespace || item.namespace === "functions") && item.name === "write_stdin" ? args?.session_id
        : forwarded?.name === "write_stdin" ? forwarded.args.session_id : null;
      const processOrigin = pollId != null ? this.active.get(`process:${pollId}`)
        || [...this.active.values()].filter((op) => op.transport === "native_event" && op.state === "result_pending")
          .map((op) => ({ ...op, kind: "process", id: op.processId })).find((op) => op.id === String(pollId)) : null;
      const knownCommandIds = pollId != null && !processOrigin ? [...this.commands.values()]
        .filter((command) => command.started && !command.conflicted && this.seenTurns.has(command.turnId)
          && !this.commandEnds.has(command.callId)).map((command) => command.callId) : [];
      // A prior real Post is already a terminal receipt; missing old native
      // item_completed must not make it a blocker. Keep those IDs separately:
      // an actual late native terminal can still bind a poll read from a
      // snapshot whose Post had already been persisted before this scan.
      const pendingCommandIds = knownCommandIds.filter((id) => !this.commands.get(id).terminal);
      this.calls.set(item.call_id, { ...item, observedTurnId: this.currentTurnId, observedOrder: this.order, commandCoverage,
        processOrigin, pollId: pollId == null ? null : String(pollId), knownCommandIds, pendingCommandIds });
      this.unanswered.add(item.call_id);
      return;
    }
    if (!["function_call_output", "custom_tool_call_output"].includes(item?.type)) return;
    this.unanswered.delete(item.call_id);
    const call = this.calls.get(item.call_id);
    if (!call || (call.namespace && call.namespace !== "functions")) return;
    if (call.name === "exec" && !call.commandCoverage) this.active.set(`unknown:${item.call_id}`, {
      kind: "unknown", id: item.call_id, callId: item.call_id, turnId: call.observedTurnId,
      transport: "legacy_code_mode", state: "execution_coverage_unknown",
    });
    const text = firstText(item.output);
    if (typeof text !== "string") return;
    const args = parse(call.arguments);
    if (["exec_command", "write_stdin"].includes(call.name)) {
      const header = text.split("\nOutput:\n", 1)[0];
      if (!header.startsWith("Chunk ID: ")) return;
      const running = /^Process running with session ID ([0-9]+)$/mu.exec(header);
      const nativeCommand = this.commands.get(item.call_id);
      if (running && !(nativeCommand?.terminal && !nativeCommand.conflicted)) this.rememberRunning({ kind: "process", id: running[1], callId: item.call_id,
        turnId: call.observedTurnId, ...(call.name === "exec_command" && typeof args?.cmd === "string" ? { commandDigest: payloadHash(args.cmd) } : {}) });
      if (/^Process exited with code -?[0-9]+$/mu.test(header) && call.name === "write_stdin" && args?.session_id != null) {
        this.finishPoll(item.call_id, args.session_id);
      }
    }
    if (["exec", "wait"].includes(call.name)) {
      const blocks = Array.isArray(item.output) ? item.output.slice(1) : [];
      const forwarded = call.name === "exec" ? forwardedToolCall(call.input ?? args?.input ?? args?.code) : null;
      const pending = call.name === "wait" ? this.cells.get(String(args?.cell_id)) : null;
      if (pending && blocks.length) pending.blocks.push(...blocks);
      const running = /^Script running with cell ID ([A-Za-z0-9_-]+)(?:\n|$)/u.exec(text);
      if (running) {
        this.active.delete(`unknown:${item.call_id}`);
        const existing = this.active.get(`cell:${running[1]}`);
        this.active.set(`cell:${running[1]}`, { kind: "cell", id: running[1], callId: existing?.callId || item.call_id });
        if (call.name === "exec") this.cells.set(running[1], { forwarded, blocks, callId: item.call_id });
      }
      if (/^Script (?:completed|terminated)(?:\n|$)/u.test(text)) {
        if (call.name === "exec") this.observeForwarded(forwarded, blocks, item.call_id);
        else if (pending) this.observeForwarded(pending.forwarded, pending.blocks, pending.callId);
      }
      if (/^Script (?:completed|terminated)(?:\n|$)/u.test(text) && call.name === "wait" && args?.cell_id != null) {
        this.active.delete(`cell:${args.cell_id}`);
        this.cells.delete(String(args.cell_id));
      }
    }
  }

  // A maintenance child may only poll an already observed native handle. It
  // cannot send input, start another process, terminate a cell, or run code.
  permitsPoll(input) {
    const forwarded = forwardedPollInput(input);
    if (forwarded?.name === "write_stdin") return this.permitsPoll({ tool_name: "write_stdin", tool_input: forwarded.args });
    const args = input.tool_input;
    if (!args || typeof args !== "object") return false;
    if (input.tool_name === "write_stdin" && (args.chars == null || args.chars === "")
      && Object.keys(args).every((key) => ["session_id", "chars", "yield_time_ms", "max_output_tokens"].includes(key))) {
      return this.active.has(`process:${args.session_id}`) || [...this.active.values()].some((op) =>
        op.transport === "native_event" && op.state === "result_pending" && op.processId === String(args.session_id));
    }
    if (input.tool_name === "wait" && args.terminate !== true
      && Object.keys(args).every((key) => ["cell_id", "terminate", "yield_time_ms", "max_tokens"].includes(key))) {
      return this.active.has(`cell:${args.cell_id}`);
    }
    return false;
  }
}
