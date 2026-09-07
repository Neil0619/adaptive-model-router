import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import { canonicalJson, payloadHash } from "./io.mjs";

export const CARRIER_TYPE = "adaptive-model-router/delegation-ticket-v2";
export const CONTEXT_PACKAGE_BYTE_LIMIT = 64 * 1024;
export const MINIMUM_FREE_DISK_BYTES = 4 * 1024 * 1024 * 1024;
export const ROUTER_CHILD_BYTE_LIMIT = 1024 * 1024 * 1024;
export const ROUTER_CHILD_RESERVATION_BYTES = 256 * 1024 * 1024;
export const ROUTER_GLOBAL_PENDING_LIMIT = 4;
export const TERMINAL_ATTEMPT_HISTORY_LIMIT = 64;

const TASK_NAME_PREFIX = "router_";
const TICKET_PATTERN = /^[a-f0-9]{32}$/u;
const LEGACY_MARKER_PREFIX = "[[adaptive-model-router:ticket:";
const ROUTER_ACTIVATION_MESSAGE = [
  "Use only the bounded Adaptive Model Router context injected by the trusted SubagentStart hook.",
  "If that context is absent or says validation failed, stop without doing work or spawning another subagent.",
].join(" ");

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function contextKey(db) {
  const salt = db.prepare("SELECT value FROM meta WHERE key = 'local_salt'").get()?.value;
  if (typeof salt !== "string" || !salt) throw new Error("router context encryption key is unavailable");
  return createHash("sha256").update(`adaptive-router-context\0${salt}`).digest();
}

function sealContextPackage(db, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contextKey(db), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["enc-v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

function openContextPackage(db, value) {
  const [version, iv, tag, encrypted, ...extra] = String(value || "").split(":");
  if (version !== "enc-v1" || !iv || !tag || !encrypted || extra.length) {
    throw new Error("router context package encoding is invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", contextKey(db), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function nowIso() {
  return new Date().toISOString();
}

export function buildContextPackage(input) {
  const packageValue = {
    schemaVersion: "router-context-package/1",
    objective: input.goal.normalize("NFC"),
    phase: input.phase.normalize("NFC"),
    evidence: input.evidence,
    constraints: [
      "Work only on this bounded stage and return the result to the parent root task.",
      "Do not spawn another routed subagent or change Adaptive Model Router controls.",
      "The parent root task owns integration, verification, user communication, and route outcome recording.",
    ],
  };
  const encoded = canonicalJson(packageValue);
  const message = [
    "Adaptive Model Router bounded context package (no parent history is inherited):",
    encoded,
  ].join("\n");
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > CONTEXT_PACKAGE_BYTE_LIMIT) {
    return { accepted: false, reasonCode: "CONTEXT_PACKAGE_TOO_LARGE", bytes };
  }
  return { accepted: true, encoded, message, bytes };
}

export function inspectFreeDisk(cwd, {
  probe = null,
  minimumFreeBytes = MINIMUM_FREE_DISK_BYTES,
  reservedBytes = 0,
} = {}) {
  try {
    const raw = probe
      ? probe(cwd)
      : (() => {
          const stats = statfsSync(cwd, { bigint: true });
          return stats.bavail * stats.bsize;
        })();
    const freeBytes = typeof raw === "bigint" ? raw : BigInt(Math.trunc(Number(raw)));
    const reservation = BigInt(Math.trunc(Number(reservedBytes)));
    if (freeBytes < 0n || reservation < 0n) throw new Error("free disk bytes must not be negative");
    return {
      trusted: true,
      allowed: freeBytes - reservation >= BigInt(minimumFreeBytes),
      freeBytes,
      reservedBytes: reservation,
    };
  } catch {
    return { trusted: false, allowed: false, freeBytes: null, reservedBytes: null };
  }
}

export function createDelegationTicket() {
  const ticket = randomBytes(16).toString("hex");
  const taskName = `${TASK_NAME_PREFIX}${ticket}`;
  return {
    ticket,
    ticketHash: sha256(ticket),
    carrier: {
      type: CARRIER_TYPE,
      taskName,
      message: ROUTER_ACTIVATION_MESSAGE,
      instruction: "Call direct native spawn_agent once: carrier.taskName as task_name, carrier.message as message, fork_turns=none, target.model as model, target.effort as reasoning_effort. Never omit a parameter or use functions.exec/nested tools. Trusted hooks inject bounded context into that child.",
    },
  };
}

export function parseCarrierTaskName(value) {
  if (typeof value !== "string") return { marked: false };
  if (!value.startsWith(TASK_NAME_PREFIX)) return { marked: false };
  const ticket = value.slice(TASK_NAME_PREFIX.length);
  // Only the complete high-entropy shape reserves the namespace. Human or
  // third-party task names such as `router_review` remain entirely unmarked.
  if (!TICKET_PATTERN.test(ticket)) return { marked: false };
  return { marked: true, valid: true, ticket, taskName: value };
}

export function parseLegacyCarrierMessage(value) {
  if (typeof value !== "string") return { marked: false };
  return { marked: value.startsWith(LEGACY_MARKER_PREFIX) };
}

export function insertDelegationAttempt(db, context, route, ticket, contextPackage) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO delegation_attempts(
      route_id, project_id, context_key, ticket_hash, model, effort,
      context_package, context_package_bytes, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    route.routeId,
    context.projectId,
    context.contextKey,
    ticket.ticketHash,
    route.target.model,
    route.target.effort,
    sealContextPackage(db, contextPackage.message),
    contextPackage.bytes,
    timestamp,
    timestamp,
  );
}

export function unresolvedAttempt(db, context) {
  const rows = db.prepare(`
    SELECT * FROM delegation_attempts
    WHERE project_id = ? AND context_key = ? AND finalized_at IS NULL
    ORDER BY created_at
    LIMIT 2
  `).all(context.projectId, context.contextKey);
  if (rows.length > 1) throw new Error("delegation gate contains multiple unresolved attempts");
  const row = rows[0] || null;
  if (!row) return null;
  if (!row.route_id || !row.ticket_hash || !row.model || !row.effort || !row.context_package) {
    throw new Error("delegation gate contains an untrusted unresolved attempt");
  }
  let opened;
  try {
    opened = openContextPackage(db, row.context_package);
  } catch {
    throw new Error("delegation gate context package is untrusted");
  }
  if (Number(row.context_package_bytes) !== Buffer.byteLength(opened, "utf8")
      || Number(row.context_package_bytes) > CONTEXT_PACKAGE_BYTE_LIMIT) {
    throw new Error("delegation gate context package is untrusted");
  }
  return row;
}

export function inspectRouterChildBudget(db, _context, {
  maximumBytes = ROUTER_CHILD_BYTE_LIMIT,
  reservationBytes = ROUTER_CHILD_RESERVATION_BYTES,
  maximumPending = ROUTER_GLOBAL_PENDING_LIMIT,
} = {}) {
  const usage = db.prepare(`
    SELECT COALESCE(SUM(total_transcript_bytes), 0) AS total_transcript_bytes,
           COALESCE(MAX(untrusted), 0) AS untrusted
    FROM delegation_usage
  `).get();
  const pending = Number(db.prepare(`
    SELECT count(*) AS count FROM delegation_attempts WHERE finalized_at IS NULL
  `).get().count);
  if (usage?.untrusted === 1) return { trusted: false, allowed: false };
  const usedBytes = Number(usage?.total_transcript_bytes || 0);
  if (
    !Number.isSafeInteger(usedBytes)
    || usedBytes < 0
    || !Number.isSafeInteger(pending)
    || pending < 0
    || !Number.isSafeInteger(reservationBytes)
    || reservationBytes < 0
  ) return { trusted: false, allowed: false };
  const nextReservationBytes = (pending + 1) * reservationBytes;
  return {
    trusted: true,
    allowed: pending < maximumPending && usedBytes + nextReservationBytes <= maximumBytes,
    usedBytes,
    pending,
    nextReservationBytes,
  };
}

function finalizeIfSafe(db, row) {
  const childTerminal = row.post_observed === 1
    && ((row.no_child === 1 && row.transcript_bytes === 0)
      || (row.stop_observed === 1 && row.agent_id && Number.isSafeInteger(row.transcript_bytes)));
  if (row.ambiguous !== 0 || row.outcome_recorded !== 1 || !childTerminal || row.finalized_at) return false;
  const timestamp = nowIso();
  db.prepare(`
    UPDATE delegation_attempts
    SET finalized_at = ?, updated_at = ?, ticket_hash = NULL, context_package = NULL
    WHERE route_id = ? AND finalized_at IS NULL
  `).run(timestamp, timestamp, row.route_id);
  db.prepare(`
    INSERT INTO delegation_usage(project_id, context_key, total_transcript_bytes, untrusted, updated_at)
    VALUES(?, ?, ?, 0, ?)
    ON CONFLICT(project_id, context_key) DO UPDATE SET
      total_transcript_bytes = total_transcript_bytes + excluded.total_transcript_bytes,
      updated_at = excluded.updated_at
  `).run(row.project_id, row.context_key, Number(row.transcript_bytes || 0), timestamp);
  db.prepare(`
    DELETE FROM delegation_attempts
    WHERE project_id = ? AND context_key = ? AND finalized_at IS NOT NULL
      AND route_id NOT IN (
        SELECT route_id FROM delegation_attempts
        WHERE project_id = ? AND context_key = ? AND finalized_at IS NOT NULL
        ORDER BY finalized_at DESC LIMIT ?
      )
  `).run(
    row.project_id,
    row.context_key,
    row.project_id,
    row.context_key,
    TERMINAL_ATTEMPT_HISTORY_LIMIT,
  );
  return true;
}

export function markDelegationOutcome(db, context, routeId, status) {
  const timestamp = nowIso();
  db.prepare(`
    UPDATE delegation_attempts
    SET outcome_recorded = 1, outcome_status = ?, updated_at = ?
    WHERE route_id = ? AND project_id = ? AND context_key = ?
  `).run(status, timestamp, routeId, context.projectId, context.contextKey);
  const row = db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(routeId);
  return row ? finalizeIfSafe(db, row) : false;
}

export function markPredispatchReconciliation(db, context, routeId) {
  const changed = db.prepare(`
    UPDATE delegation_attempts
    SET ambiguous = 1, updated_at = ?
    WHERE route_id = ? AND project_id = ? AND context_key = ?
      AND ticket_consumed = 0 AND finalized_at IS NULL
  `).run(nowIso(), routeId, context.projectId, context.contextKey);
  return Number(changed.changes) === 1;
}

export function reconcileLegacyPredispatchOutcomes(db) {
  const attempts = db.prepare(`
    SELECT route_id FROM delegation_attempts
    WHERE ticket_consumed = 0 AND outcome_recorded = 1 AND finalized_at IS NULL
  `).all();
  if (attempts.length === 0) return 0;
  const timestamp = nowIso();
  const changed = db.prepare(`
    UPDATE delegation_attempts
    SET ticket_hash = NULL, context_package = NULL, ambiguous = 1,
        updated_at = ?, finalized_at = ?
    WHERE ticket_consumed = 0 AND outcome_recorded = 1 AND finalized_at IS NULL
  `).run(timestamp, timestamp);
  const excludeFromLearning = db.prepare(`
    UPDATE route_score_snapshots SET eligible_learning = 0 WHERE route_id = ?
  `);
  for (const attempt of attempts) excludeFromLearning.run(attempt.route_id);
  return Number(changed.changes);
}

export function consumeDelegationTicket(db, context, {
  taskName,
  turnId,
  toolUseId,
  toolInput,
}) {
  return (() => {
    const parsed = parseCarrierTaskName(taskName);
    if (!parsed.valid || toolInput?.task_name !== parsed.taskName) {
      return { allowed: false, reason: "Router delegation task name is malformed or inconsistent." };
    }
    const ticketHash = sha256(parsed.ticket);
    const row = db.prepare(`
      SELECT * FROM delegation_attempts
      WHERE project_id = ? AND context_key = ? AND ticket_hash = ? AND finalized_at IS NULL
    `).get(context.projectId, context.contextKey, ticketHash);
    if (!row) return { allowed: false, reason: "Router delegation ticket is invalid, consumed, or no longer active." };
    if (row.ambiguous === 1) {
      return { allowed: false, reason: "Router delegation lifecycle requires reconciliation and cannot be dispatched." };
    }
    if (row.ticket_consumed === 1) return { allowed: false, reason: "Router delegation ticket has already been consumed." };
    if (!turnId || !toolUseId || typeof toolInput !== "object" || toolInput == null) {
      return { allowed: false, reason: "Router-marked Agent call is missing trusted hook correlation fields." };
    }
    if (toolInput.model !== row.model || toolInput.reasoning_effort !== row.effort) {
      // This exact admission was presented to the trusted launch boundary and
      // rejected. It must not later be reused by Stop-driven or manual retries.
      // Keep its reservation until the native host's refusal is audited; this
      // flag is not a no-child proof, dispatch handshake, or terminal outcome.
      markPredispatchReconciliation(db, context, row.route_id);
      return { allowed: false, reason: "Router-marked Agent model or reasoning effort does not match the admitted route." };
    }
    if (typeof toolInput.message !== "string" || !toolInput.message) {
      return { allowed: false, reason: "Router-marked Agent call is missing its encrypted activation message." };
    }
    if (toolInput.fork_turns !== "none") {
      return { allowed: false, reason: "Router-marked Agent call must use fork_turns=none before trusted dispatch." };
    }
    const timestamp = nowIso();
    const changed = db.prepare(`
      UPDATE delegation_attempts
      SET ticket_consumed = 1, root_turn_id = ?, tool_use_id = ?,
          dispatch_input_digest = ?, updated_at = ?
      WHERE route_id = ? AND ticket_consumed = 0 AND ambiguous = 0 AND finalized_at IS NULL
    `).run(turnId, toolUseId, payloadHash(toolInput), timestamp, row.route_id);
    if (Number(changed.changes) !== 1) {
      return { allowed: false, reason: "Router delegation ticket could not be consumed atomically." };
    }
    return { allowed: true, routeId: row.route_id };
  })();
}

export function claimDelegationSubagent(db, context, {
  taskName,
  agentId,
  model,
}) {
  const parsed = parseCarrierTaskName(taskName);
  if (!parsed.valid || typeof agentId !== "string" || !agentId.trim()) {
    return { matched: false };
  }
  const row = db.prepare(`
    SELECT * FROM delegation_attempts
    WHERE project_id = ? AND context_key = ? AND ticket_hash = ?
      AND finalized_at IS NULL
  `).get(context.projectId, context.contextKey, sha256(parsed.ticket));
  if (!row) return { matched: false };
  const agentKey = sha256(agentId.normalize("NFC"));
  if (row.ticket_consumed !== 1) {
    // A verified Router-marked thread-spawn identity proves that a child now
    // exists, even when this host skipped the expected PreToolUse path. Keep
    // the gate occupied and retain the observed child identity for diagnosis;
    // never infer the missing root turn/tool_use_id or authorize the child.
    db.prepare(`
      UPDATE delegation_attempts
      SET early_agent_id = COALESCE(early_agent_id, ?), ambiguous = 1, updated_at = ?
      WHERE route_id = ? AND ticket_consumed = 0 AND finalized_at IS NULL
    `).run(agentKey, nowIso(), row.route_id);
    return { matched: true, allowed: false, reason: "dispatch_ticket_unconsumed" };
  }
  if (
    (typeof model === "string" && model && model !== row.model)
    || row.no_child === 1
    || (row.early_agent_id && row.early_agent_id !== agentKey)
    || (row.agent_id && row.agent_id !== agentKey)
  ) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, allowed: false };
  }
  let contextPackage;
  try {
    contextPackage = openContextPackage(db, row.context_package);
  } catch {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, allowed: false };
  }
  db.prepare(`
    UPDATE delegation_attempts
    SET early_agent_id = COALESCE(early_agent_id, ?),
        agent_id = CASE
          WHEN post_observed = 1 THEN COALESCE(agent_id, ?)
          ELSE agent_id
        END,
        updated_at = ?
    WHERE route_id = ?
  `).run(agentKey, agentKey, nowIso(), row.route_id);
  return {
    matched: true,
    allowed: true,
    routeId: row.route_id,
    contextPackage,
  };
}

export function inspectManagedSubagent(db, context, {
  taskName,
  agentId,
}) {
  const parsed = parseCarrierTaskName(taskName);
  if (!parsed.valid || typeof agentId !== "string" || !agentId.trim()) {
    return { managed: false };
  }
  const ticketHash = sha256(parsed.ticket);
  const agentKey = sha256(agentId.normalize("NFC"));
  const rows = db.prepare(`
    SELECT * FROM delegation_attempts
    WHERE project_id = ? AND context_key = ?
      AND (ticket_hash = ? OR early_agent_id = ? OR agent_id = ?)
    ORDER BY created_at DESC LIMIT 2
  `).all(context.projectId, context.contextKey, ticketHash, agentKey, agentKey);
  if (rows.length !== 1) return { managed: false };
  const row = rows[0];
  if (
    (row.early_agent_id && row.early_agent_id !== agentKey)
    || (row.agent_id && row.agent_id !== agentKey)
  ) return { managed: false };
  if (
    row.ticket_consumed !== 1
    || (!row.early_agent_id && !row.agent_id)
    || row.ambiguous !== 0
  ) {
    return { managed: true, trusted: false, contextPackage: null };
  }
  let contextPackage = null;
  if (row.context_package) {
    try {
      contextPackage = openContextPackage(db, row.context_package);
    } catch {
      return { managed: true, trusted: false, contextPackage: null };
    }
  }
  return {
    managed: true,
    trusted: true,
    finalized: Boolean(row.finalized_at),
    contextPackage,
  };
}

function decodedResponse(value) {
  if (typeof value !== "string" || value.length > 64 * 1024) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function collectAgentIds(value, output = new Set()) {
  value = decodedResponse(value);
  if (Array.isArray(value)) {
    for (const item of value) collectAgentIds(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (["agent_id", "agentId"].includes(key) && typeof item === "string" && item.trim()) {
      output.add(item.normalize("NFC"));
    } else {
      collectAgentIds(item, output);
    }
  }
  return output;
}

function collectTaskNames(value, output = new Set()) {
  value = decodedResponse(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTaskNames(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (["task_name", "taskName"].includes(key) && typeof item === "string" && item.trim()) {
      output.add(item.normalize("NFC"));
    } else {
      collectTaskNames(item, output);
    }
  }
  return output;
}

function responseProvesNoChild(response) {
  response = decodedResponse(response);
  if (!response || typeof response !== "object") return false;
  return response.no_agent_created === true || response.agent_created === false;
}

export function observeAgentResult(db, context, {
  turnId,
  toolUseId,
  toolInput,
  toolResponse,
}) {
  const row = db.prepare(`
    SELECT * FROM delegation_attempts
    WHERE project_id = ? AND context_key = ? AND root_turn_id = ? AND tool_use_id = ?
      AND ticket_consumed = 1 AND finalized_at IS NULL
  `).get(context.projectId, context.contextKey, turnId, toolUseId);
  if (!row) return { matched: false };
  if (payloadHash(toolInput) !== row.dispatch_input_digest) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, correlated: false, reason: "dispatch_input_mismatch" };
  }
  const agentIds = [...collectAgentIds(toolResponse)];
  const taskNames = [...collectTaskNames(toolResponse)];
  const expectedTaskNames = new Set([toolInput.task_name, `/root/${toolInput.task_name}`]);
  const taskNameMatched = taskNames.length === 1 && expectedTaskNames.has(taskNames[0]);
  if (taskNames.length > 1 || (taskNames.length === 1 && !taskNameMatched)) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, post_observed = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, correlated: false, reason: "ambiguous_task_name" };
  }
  if (agentIds.length > 1) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, post_observed = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, correlated: false, reason: "ambiguous_agent_id" };
  }
  const noChild = responseProvesNoChild(toolResponse);
  if (agentIds.length === 0 && !noChild && !row.early_agent_id && !taskNameMatched) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, post_observed = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, correlated: false, reason: "agent_id_unavailable" };
  }
  const agentKey = agentIds[0] ? sha256(agentIds[0]) : row.early_agent_id || null;
  if (row.early_agent_id && (!agentKey || row.early_agent_id !== agentKey)) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, post_observed = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, correlated: false, reason: "early_stop_agent_mismatch" };
  }
  const timestamp = nowIso();
  db.prepare(`
    UPDATE delegation_attempts
    SET post_observed = 1, agent_id = ?, no_child = ?,
        stop_observed = CASE WHEN early_transcript_bytes IS NOT NULL THEN 1 ELSE stop_observed END,
        transcript_bytes = CASE WHEN early_transcript_bytes IS NOT NULL THEN early_transcript_bytes ELSE transcript_bytes END,
        updated_at = ?
    WHERE route_id = ?
  `).run(agentKey, noChild ? 1 : 0, timestamp, row.route_id);
  if (noChild) {
    db.prepare("UPDATE delegation_attempts SET transcript_bytes = 0 WHERE route_id = ?")
      .run(row.route_id);
  }
  const updated = db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(row.route_id);
  return {
    matched: true,
    correlated: true,
    noChild,
    awaitingSubagentStart: !noChild && !agentKey,
    routeId: row.route_id,
    finalized: finalizeIfSafe(db, updated),
  };
}

export function observeSubagentStop(db, context, taskName, agentId, transcriptBytes) {
  const parsed = parseCarrierTaskName(taskName);
  if (!parsed.valid || typeof agentId !== "string" || !agentId.trim()) return { matched: false };
  const agentKey = sha256(agentId.normalize("NFC"));
  const rows = db.prepare(`
    SELECT * FROM delegation_attempts
    WHERE project_id = ? AND context_key = ? AND ticket_hash = ?
      AND (agent_id = ? OR early_agent_id = ?) AND finalized_at IS NULL
    LIMIT 2
  `).all(context.projectId, context.contextKey, sha256(parsed.ticket), agentKey, agentKey);
  if (rows.length === 0) return { matched: false };
  if (rows.length !== 1) return { matched: false };
  const row = rows[0];
  if (!Number.isSafeInteger(transcriptBytes) || transcriptBytes < 0) {
    db.prepare("UPDATE delegation_attempts SET ambiguous = 1, stop_observed = 1, updated_at = ? WHERE route_id = ?")
      .run(nowIso(), row.route_id);
    return { matched: true, finalized: false, reason: "transcript_size_untrusted" };
  }
  if (row.post_observed === 0) {
    db.prepare(`
      UPDATE delegation_attempts
      SET early_transcript_bytes = ?, updated_at = ? WHERE route_id = ?
    `).run(transcriptBytes, nowIso(), row.route_id);
    return {
      matched: true,
      correlated: true,
      finalized: false,
      reason: "awaiting_post_tool_use",
      routeId: row.route_id,
    };
  }
  db.prepare(`
    UPDATE delegation_attempts
    SET stop_observed = 1, transcript_bytes = ?, updated_at = ? WHERE route_id = ?
  `).run(transcriptBytes, nowIso(), row.route_id);
  const updated = db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(row.route_id);
  return { matched: true, routeId: row.route_id, finalized: finalizeIfSafe(db, updated) };
}
