import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CATEGORIES, DEFAULT_OFFSETS } from "./constants.mjs";
import { canonicalJson, clamp, readJson } from "./io.mjs";

function legacyRoot() {
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  return join(codexHome, "adaptive-model-router");
}

async function historyCount(root) {
  let total = 0;
  for (const name of ["events.jsonl", "history.jsonl", "outcomes.jsonl"]) {
    try {
      const text = await readFile(join(root, name), "utf8");
      total += text.split(/\r?\n/).filter(Boolean).length;
    } catch {
      // Missing legacy history is normal.
    }
  }
  return total;
}

export async function importLegacySettingsAndPolicy(store, context, confirmation) {
  if (confirmation !== "IMPORT_LEGACY_SETTINGS_POLICY") throw new Error("exact legacy import confirmation is required");
  const existing = store.db.prepare("SELECT * FROM legacy_imports WHERE project_id = ?").get(context.projectId);
  if (existing) {
    return {
      imported: false,
      idempotent: true,
      settingsImported: Boolean(existing.settings_imported),
      policyImported: Boolean(existing.policy_imported),
      historyRecordsArchived: Number(existing.history_records_archived),
    };
  }
  const root = legacyRoot();
  const settings = await readJson(join(root, "settings.json"), null);
  const policy = await readJson(join(root, "policy.json"), null);
  const records = await historyCount(root);
  const settingsChanges = {};
  if (typeof settings?.enabled === "boolean") settingsChanges.enabled = settings.enabled;
  const approvedPolicy = Array.isArray(policy?.approvedProposals) && policy.approvedProposals.length > 0;
  const offsets = { ...DEFAULT_OFFSETS };
  if (approvedPolicy) {
    for (const category of CATEGORIES) {
      const value = Number(policy?.categoryOffsets?.[category]);
      if (Number.isFinite(value)) offsets[category] = clamp(Math.trunc(value), -15, 15);
    }
  }
  if (Object.keys(settingsChanges).length) store.configure(context, settingsChanges, "project");
  store.ensurePolicy(context);
  store.transaction(() => {
    if (approvedPolicy) {
      const active = store.db.prepare("SELECT active_revision_id FROM project_policy WHERE project_id = ?")
        .get(context.projectId);
      const outcomeSeq = Number(store.db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM outcomes WHERE project_id = ?")
        .get(context.projectId).seq);
      const revisionId = randomUUID();
      store.db.prepare(`
        INSERT INTO policy_revisions(
          revision_id, project_id, parent_revision_id, offsets_json, outcome_seq, proposal_id, created_at
        ) VALUES(?, ?, ?, ?, ?, 'legacy-approved-policy', ?)
      `).run(revisionId, context.projectId, active.active_revision_id, canonicalJson(offsets), outcomeSeq, new Date().toISOString());
      store.db.prepare("UPDATE project_policy SET active_revision_id = ? WHERE project_id = ?")
        .run(revisionId, context.projectId);
    }
    store.db.prepare(`
      INSERT INTO legacy_imports(
        project_id, settings_imported, policy_imported, history_records_archived, imported_at
      ) VALUES(?, ?, ?, ?, ?)
    `).run(
      context.projectId,
      Object.keys(settingsChanges).length ? 1 : 0,
      approvedPolicy ? 1 : 0,
      records,
      new Date().toISOString(),
    );
  });
  return {
    imported: true,
    idempotent: false,
    settingsImported: Object.keys(settingsChanges).length > 0,
    policyImported: approvedPolicy,
    historyRecordsArchived: records,
    historyUsedForLearning: false,
  };
}
