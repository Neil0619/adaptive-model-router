import { readStableRollout } from "./native-rollout-reader.mjs";
import { payloadHash } from "./io.mjs";
import { NativeOperationEvidence } from "./native-operation-evidence.mjs";
import { createHash } from "node:crypto";

const itemTurn = (payload) => payload.internal_chat_message_metadata_passthrough?.turn_id;
const textContent = (content) => Array.isArray(content)
  ? content.map((part) => typeof part.text === "string" ? part.text : "").join("") : null;

// Codex 0.153.4 keeps the memory trailer in response_item, but separates it
// from AgentMessage and the Stop text. Only that exact native representation
// may supply a second digest. Never trim or strip arbitrary assistant text.
function memoryStopProof(final, native, completions) {
  if (!final.textOnly || !native || native.conflicted || native.item.phase !== "final_answer") return null;
  if (!Array.isArray(native.item.content) || !native.item.content.length
    || native.item.content.some((part) => part?.type !== "Text" || typeof part.text !== "string")) return null;
  const text = textContent(native.item.content), citation = native.item.memory_citation;
  if (text === null || !citation || !Array.isArray(citation.entries) || !citation.entries.length
    || !Array.isArray(citation.rolloutIds)) return null;
  const singleLine = (value) => typeof value === "string" && value.length > 0 && !/[\r\n<>]/u.test(value);
  if (citation.entries.some((entry) => !singleLine(entry?.path) || !singleLine(entry?.note)
    || !Number.isSafeInteger(entry.lineStart) || entry.lineStart < 1
    || !Number.isSafeInteger(entry.lineEnd) || entry.lineEnd < entry.lineStart)
    || citation.rolloutIds.some((id) => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))) return null;
  const trailer = `<oai-mem-citation>\n<citation_entries>\n${citation.entries.map((entry) =>
    `${entry.path}:${entry.lineStart}-${entry.lineEnd}|note=[${entry.note}]`).join("\n")}\n</citation_entries>\n<rollout_ids>\n${citation.rolloutIds.map((id) => `${id}\n`).join("")}</rollout_ids>\n</oai-mem-citation>`;
  if (text.includes("<oai-mem-citation>") || final.text !== text + trailer) return null;
  const ends = completions.filter((end) => end.line > final.line);
  if (!ends.length || ends.some((end) => end.line <= native.line || end.text !== text)) return null;
  return { stopDigest: payloadHash(text), stopEvidenceDigest: payloadHash({ native: native.digest,
    completions: ends.map((end) => end.digest) }) };
}

/** Read only the native identity, input order and final-turn facts. Never return
 * message contents or model reasoning. Limits fail explicitly, not as emptiness.
 */
export function readChildTurnEvidence(locator, { commands = [] } = {}) {

  const messages = [];
  const completions = new Map();
  const completionEvidence = new Map();
  const nativeFinals = new Map();
  const ids = new Set();
  let latestStarted = null;
  let lastFinal = null;
  let finalSource = null;
  let pendingMode = null;
  const operations = new NativeOperationEvidence({ childId: locator.childId, commands });
  const coverage = locator.commandCoverage;
  if (coverage && (coverage.version !== 1 || !Number.isSafeInteger(coverage.throughLine) || coverage.throughLine < 1
    || !/^[a-f0-9]{64}$/u.test(coverage.prefixDigest))) throw new Error("command coverage boundary is invalid");
  const prefix = createHash("sha256");
  let covered = false;
  const operationRecords = [];
  const source = readStableRollout(locator.transcriptPath, (entry, lineNumber) => {
    const value = entry.payload;
    operations.observe(entry, { commandCoverage: covered });
    if (coverage && lineNumber <= coverage.throughLine) {
      prefix.update(JSON.stringify(entry) + "\n");
      if (lineNumber === coverage.throughLine) {
        if (prefix.digest("hex") !== coverage.prefixDigest) throw new Error("command coverage prefix changed");
        covered = true;
      }
    }
    if ((entry.type === "response_item" && ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(value?.type))
      || (entry.type === "event_msg" && ["item_started", "item_completed"].includes(value?.type)
        && ["CommandExecution", "FileChange"].includes(value.item?.type))) operationRecords.push(payloadHash({ type: entry.type, payload: value }));
    if (lineNumber === 1) {
      const spawn = value?.source?.subagent?.thread_spawn;
      if (entry.type !== "session_meta" || value.id !== locator.childId
        || value.parent_thread_id !== locator.parentContextId || value.session_id !== locator.parentContextId
        || value.agent_path !== locator.agentPath || spawn?.parent_thread_id !== locator.parentContextId
        || spawn.agent_path !== locator.agentPath || spawn.depth !== 1) throw new Error("child transcript identity changed");
    }
    if (entry.type === "inter_agent_communication_metadata") {
      if (typeof value?.trigger_turn !== "boolean" || pendingMode !== null) throw new Error("unpaired native communication metadata");
      pendingMode = value.trigger_turn;
    } else if (entry.type === "response_item" && value?.type === "agent_message") {
      if (pendingMode === null || typeof value.id !== "string" || ids.has(value.id)
        || value.recipient !== locator.agentPath || typeof value.author !== "string" || !itemTurn(value)) {
        throw new Error("untrusted native child input order");
      }
      ids.add(value.id);
      messages.push({ id: value.id, author: value.author, turnId: itemTurn(value),
        triggerTurn: pendingMode, digest: payloadHash(value.content), line: lineNumber });
      pendingMode = null;
    } else if (entry.type === "response_item" && value?.type === "message"
      && value.role === "assistant" && value.phase === "final_answer") {
      const text = textContent(value.content);
      if (!itemTurn(value) || text === null) throw new Error("final result lacks native turn identity");
      lastFinal = { turnId: itemTurn(value), digest: payloadHash(text), line: lineNumber };
      finalSource = { ...lastFinal, id: value.id, text, textOnly: Array.isArray(value.content) && value.content.length > 0
        && value.content.every((part) => part?.type === "output_text" && typeof part.text === "string") };
    } else if (entry.type === "event_msg" && value?.type === "item_completed"
      && value.thread_id === locator.childId && value.item?.type === "AgentMessage"
      && typeof value.item.id === "string" && typeof value.turn_id === "string") {
      const key = JSON.stringify([value.turn_id, value.item.id]);
      const previous = nativeFinals.get(key), itemDigest = payloadHash(value.item);
      nativeFinals.set(key, { item: value.item, itemDigest, digest: payloadHash(entry), line: lineNumber,
        conflicted: previous?.conflicted || Boolean(previous && previous.itemDigest !== itemDigest) });
    } else if (entry.type === "event_msg" && value?.type === "task_started") {
      latestStarted = value.turn_id;
    } else if (entry.type === "event_msg" && value?.type === "task_complete") {
      completions.set(value.turn_id, lineNumber);
      if (!completionEvidence.has(value.turn_id)) completionEvidence.set(value.turn_id, []);
      completionEvidence.get(value.turn_id).push({ line: lineNumber, text: value.last_agent_message, digest: payloadHash(entry) });
    }
  });
  if (coverage && !covered) throw new Error("command coverage prefix is incomplete");
  if (pendingMode !== null) throw new Error("unpaired native communication metadata");
  if (lastFinal && typeof finalSource.id === "string" && finalSource.id.length > 0) {
    const proof = memoryStopProof(finalSource, nativeFinals.get(JSON.stringify([lastFinal.turnId, finalSource.id])),
      completionEvidence.get(lastFinal.turnId) || []);
    if (proof) lastFinal = { ...lastFinal, ...proof };
  }
  const turnFinished = Boolean(lastFinal && completions.get(lastFinal.turnId) > lastFinal.line
    && (!latestStarted || latestStarted === lastFinal.turnId)
    && messages.every((message) => message.line < lastFinal.line));
  const finished = turnFinished && operations.unanswered.size === 0 && operations.active.size === 0;
  return { messages, lastFinal, finished, turnFinished, operationDigest: payloadHash({ operationRecords, coverage: coverage || null }), pendingCalls: [...operations.unanswered],
    commandCompletions: [...operations.commandEnds.values()].sort((a, b) => a.callId.localeCompare(b.callId)),
    pendingOperations: [...operations.active.values()], permitsPoll: (input) => operations.permitsPoll(input), ...source };
}
