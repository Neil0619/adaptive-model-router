import { randomUUID } from "node:crypto";
import { DEFAULT_OFFSETS } from "./constants.mjs";
import { OUTCOME_INPUT_SCHEMA } from "./contracts.mjs";
import { RouterStore } from "./database.mjs";
import { canonicalJson, clamp, parseJson } from "./io.mjs";
import { assertSchema } from "./schema.mjs";

function nowIso() {
  return new Date().toISOString();
}

function validateOutcomeSemantics(input, route) {
  if (route.action !== "delegate") throw new Error("record_outcome only accepts delegated routes");
  if (input.gate !== route.verification_gate) throw new Error("gate must match the route verification gate");
  if (input.escalations !== Number(route.escalation_count)) throw new Error("escalations must match the route");
  if (input.status === "failed" && !input.failureType) throw new Error("failed outcomes require failureType");
  if (input.status !== "failed" && input.failureType !== null) throw new Error(`${input.status} outcomes require failureType null`);
}

export function maybeGenerateProposal(store, context, category) {
  const policy = store.ensurePolicy(context);
  return store.transaction(() => {
    const current = store.db.prepare(`
      SELECT p.active_revision_id, r.offsets_json, r.outcome_seq
      FROM project_policy p JOIN policy_revisions r ON r.revision_id = p.active_revision_id
      WHERE p.project_id = ?
    `).get(context.projectId);
    if (!current || current.active_revision_id !== policy.revisionId) return null;
    const pending = store.db.prepare(`
      SELECT proposal_id FROM policy_proposals
      WHERE project_id = ? AND category = ? AND status = 'pending'
    `).get(context.projectId, category);
    if (pending) return null;
    const cursor = store.db.prepare(`
      SELECT last_outcome_seq FROM learning_cursors WHERE project_id = ? AND category = ?
    `).get(context.projectId, category);
    const afterSeq = Math.max(Number(cursor?.last_outcome_seq || 0), Number(current.outcome_seq || 0));
    const window = store.db.prepare(`
      SELECT count(*) AS eligible_count,
             coalesce(sum(CASE WHEN status = 'failed' OR user_correction = 1 OR retries > 0 THEN 1 ELSE 0 END), 0) AS affected_count,
             coalesce(min(seq), 0) AS start_seq,
             coalesce(max(seq), 0) AS end_seq
      FROM outcomes
      WHERE project_id = ? AND category = ? AND status != 'unknown' AND seq > ?
    `).get(context.projectId, category, afterSeq);
    const eligible = Number(window.eligible_count || 0);
    const affected = Number(window.affected_count || 0);
    let delta = 0;
    if (eligible >= 12 && affected >= 4) delta = 5;
    else if (eligible >= 20 && affected === 0) delta = -5;
    if (!delta) return null;
    const offsets = { ...DEFAULT_OFFSETS, ...parseJson(current.offsets_json, {}) };
    const oldOffset = Number(offsets[category] || 0);
    const newOffset = clamp(oldOffset + delta, -15, 15);
    if (newOffset === oldOffset) {
      store.db.prepare(`
        INSERT INTO learning_cursors(project_id, category, last_outcome_seq) VALUES(?, ?, ?)
        ON CONFLICT(project_id, category) DO UPDATE SET last_outcome_seq = excluded.last_outcome_seq
      `).run(context.projectId, category, Number(window.end_seq));
      return null;
    }
    const proposalId = randomUUID();
    store.db.prepare(`
      INSERT INTO policy_proposals(
        proposal_id, project_id, category, delta, base_revision_id, start_seq, end_seq,
        eligible_count, affected_count, status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      proposalId,
      context.projectId,
      category,
      delta,
      current.active_revision_id,
      Number(window.start_seq),
      Number(window.end_seq),
      eligible,
      affected,
      nowIso(),
    );
    return { proposalId, category, delta, eligibleCount: eligible, affectedCount: affected, from: oldOffset, to: newOffset };
  });
}

export function recordOutcome(input, options = {}) {
  assertSchema(OUTCOME_INPUT_SCHEMA, input, "record_outcome input");
  let ownedStore = null;
  try {
    const store = options.store || (ownedStore = new RouterStore(options.database ? { path: options.database } : {}));
    const context = store.context({ cwd: options.cwd || process.cwd(), contextId: input.contextId });
    const route = store.findRoute(context, input.routeId);
    if (!route) throw new Error("routeId does not belong to the current project and context");
    validateOutcomeSemantics(input, route);
    const result = store.insertOutcome(context, route, input);
    let proposal = null;
    if (result.recorded && input.status !== "unknown") proposal = maybeGenerateProposal(store, context, route.category);
    return { ...result, proposal };
  } finally {
    ownedStore?.close();
  }
}

function proposalResult(row) {
  return {
    proposalId: row.proposal_id,
    category: row.category,
    delta: Number(row.delta),
    eligibleCount: Number(row.eligible_count),
    affectedCount: Number(row.affected_count),
    status: row.status,
  };
}

export function listPolicyProposals({ contextId }, options = {}) {
  let ownedStore = null;
  try {
    const store = options.store || (ownedStore = new RouterStore(options.database ? { path: options.database } : {}));
    const context = store.context({ cwd: options.cwd || process.cwd(), contextId });
    return store.db.prepare(`
      SELECT proposal_id, category, delta, eligible_count, affected_count, status
      FROM policy_proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at
    `).all(context.projectId).map(proposalResult);
  } finally {
    ownedStore?.close();
  }
}

function advanceCursor(store, row) {
  store.db.prepare(`
    INSERT INTO learning_cursors(project_id, category, last_outcome_seq) VALUES(?, ?, ?)
    ON CONFLICT(project_id, category) DO UPDATE SET
      last_outcome_seq = max(last_outcome_seq, excluded.last_outcome_seq)
  `).run(row.project_id, row.category, Number(row.end_seq));
}

export function approvePolicyProposal({ contextId, proposalId }, options = {}) {
  let ownedStore = null;
  try {
    const store = options.store || (ownedStore = new RouterStore(options.database ? { path: options.database } : {}));
    const context = store.context({ cwd: options.cwd || process.cwd(), contextId });
    store.ensurePolicy(context);
    return store.transaction(() => {
      const row = store.db.prepare(`
        SELECT * FROM policy_proposals WHERE proposal_id = ? AND project_id = ?
      `).get(proposalId, context.projectId);
      if (!row) throw new Error("policy proposal was not found in the current project");
      if (row.status === "approved") return { ...proposalResult(row), idempotent: true };
      if (row.status !== "pending") throw new Error(`policy proposal is ${row.status}`);
      const active = store.db.prepare(`
        SELECT p.active_revision_id, r.offsets_json
        FROM project_policy p JOIN policy_revisions r ON r.revision_id = p.active_revision_id
        WHERE p.project_id = ?
      `).get(context.projectId);
      if (!active || active.active_revision_id !== row.base_revision_id) {
        store.db.prepare("UPDATE policy_proposals SET status = 'stale', decided_at = ? WHERE proposal_id = ?")
          .run(nowIso(), proposalId);
        advanceCursor(store, row);
        return { ...proposalResult({ ...row, status: "stale" }), stale: true };
      }
      const offsets = { ...DEFAULT_OFFSETS, ...parseJson(active.offsets_json, {}) };
      offsets[row.category] = clamp(Number(offsets[row.category] || 0) + Number(row.delta), -15, 15);
      const revisionId = randomUUID();
      store.db.prepare(`
        INSERT INTO policy_revisions(
          revision_id, project_id, parent_revision_id, offsets_json, outcome_seq, proposal_id, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        context.projectId,
        active.active_revision_id,
        canonicalJson(offsets),
        Number(row.end_seq),
        proposalId,
        nowIso(),
      );
      store.db.prepare("UPDATE project_policy SET active_revision_id = ? WHERE project_id = ?")
        .run(revisionId, context.projectId);
      store.db.prepare("UPDATE policy_proposals SET status = 'approved', decided_at = ? WHERE proposal_id = ?")
        .run(nowIso(), proposalId);
      advanceCursor(store, row);
      return { ...proposalResult({ ...row, status: "approved" }), revisionId, categoryOffset: offsets[row.category], idempotent: false };
    });
  } finally {
    ownedStore?.close();
  }
}

export function rejectPolicyProposal({ contextId, proposalId }, options = {}) {
  let ownedStore = null;
  try {
    const store = options.store || (ownedStore = new RouterStore(options.database ? { path: options.database } : {}));
    const context = store.context({ cwd: options.cwd || process.cwd(), contextId });
    return store.transaction(() => {
      const row = store.db.prepare(`
        SELECT * FROM policy_proposals WHERE proposal_id = ? AND project_id = ?
      `).get(proposalId, context.projectId);
      if (!row) throw new Error("policy proposal was not found in the current project");
      if (row.status === "rejected") return { ...proposalResult(row), idempotent: true };
      if (row.status !== "pending") throw new Error(`policy proposal is ${row.status}`);
      store.db.prepare("UPDATE policy_proposals SET status = 'rejected', decided_at = ? WHERE proposal_id = ?")
        .run(nowIso(), proposalId);
      advanceCursor(store, row);
      return { ...proposalResult({ ...row, status: "rejected" }), idempotent: false };
    });
  } finally {
    ownedStore?.close();
  }
}

export function rollbackPolicy({ contextId }, options = {}) {
  let ownedStore = null;
  try {
    const store = options.store || (ownedStore = new RouterStore(options.database ? { path: options.database } : {}));
    const context = store.context({ cwd: options.cwd || process.cwd(), contextId });
    store.ensurePolicy(context);
    return store.transaction(() => {
      const active = store.db.prepare(`
        SELECT p.active_revision_id, r.parent_revision_id
        FROM project_policy p JOIN policy_revisions r ON r.revision_id = p.active_revision_id
        WHERE p.project_id = ?
      `).get(context.projectId);
      if (!active?.parent_revision_id) return { rolledBack: false, revisionId: active?.active_revision_id || null };
      store.db.prepare("UPDATE project_policy SET active_revision_id = ? WHERE project_id = ?")
        .run(active.parent_revision_id, context.projectId);
      return { rolledBack: true, revisionId: active.parent_revision_id, fromRevisionId: active.active_revision_id };
    });
  } finally {
    ownedStore?.close();
  }
}
