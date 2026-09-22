import { canonicalJson, payloadHash } from "./io.mjs";
import { assertSchema } from "./schema.mjs";

const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const VERIFICATION_EVIDENCE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["schemaVersion", "checks"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    sourceCommit: { type: "string", pattern: "^[a-f0-9]{40}$" },
    checks: { type: "array", minItems: 1, maxItems: 16, items: {
      type: "object", additionalProperties: false, required: ["kind", "status", "reference"], properties: {
        kind: { type: "string", enum: ["unit", "integration", "lint", "typecheck", "build", "manual", "source_review", "smoke"] },
        status: { type: "string", enum: ["passed", "failed", "skipped", "not_run"] },
        commandTemplate: { type: "string", enum: ["npm test", "npm run validate", "npm run eval", "node --test", "source review", "native smoke", "other hashed command"] },
        commandDigest: hash, resultDigest: hash,
        exitCode: { type: ["integer", "null"], minimum: 0, maximum: 255 },
        reference: { type: "string", pattern: "^(artifact|check):[a-f0-9]{64}$" },
      },
    } },
  },
};

// Additive tables, no version bump or changes to existing writer columns and
// semantics. Retained-runtime interop must still be verified by the epoch gate.
export function ensureAuditSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS outcome_verification_evidence (
    route_id TEXT PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, context_key TEXT NOT NULL,
    evidence_json TEXT NOT NULL, evidence_digest TEXT NOT NULL, recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retention_coverage (
    project_id TEXT NOT NULL, context_key TEXT NOT NULL, kind TEXT NOT NULL,
    pruned_count INTEGER NOT NULL, pruned_through TEXT, recorded_at TEXT NOT NULL,
    PRIMARY KEY(project_id,context_key,kind)
  );
  CREATE TRIGGER IF NOT EXISTS clear_retention_after_project AFTER DELETE ON projects
    BEGIN DELETE FROM retention_coverage WHERE project_id=OLD.project_id; END;`);
}

export function verifyOutcomeEvidenceReplay(db, routeId, evidence) {
  if (evidence === undefined) return;
  assertSchema(VERIFICATION_EVIDENCE_SCHEMA, evidence, "verificationEvidence");
  const previous = db.prepare("SELECT evidence_digest FROM outcome_verification_evidence WHERE route_id=?").get(routeId);
  if (previous?.evidence_digest !== payloadHash(evidence)) {
    throw Object.assign(new Error("Final verification evidence is immutable; missing historical evidence cannot be backfilled as contemporaneous verification."), { code: "OUTCOME_CONFLICT" });
  }
}

export function insertOutcomeEvidence(db, context, routeId, evidence) {
  if (evidence === undefined) return;
  assertSchema(VERIFICATION_EVIDENCE_SCHEMA, evidence, "verificationEvidence");
  db.prepare("INSERT INTO outcome_verification_evidence VALUES(?,?,?,?,?,?)")
    .run(routeId, context.projectId, context.contextKey, canonicalJson(evidence), payloadHash(evidence), new Date().toISOString());
}

export function recordPrunedEvidence(db, context, kind, count, through) {
  if (!count) return;
  if (!["finalized_attempt", "completed_invocation", "settled_receipt"].includes(kind)) throw new Error("Unknown retained evidence kind");
  db.prepare(`INSERT INTO retention_coverage VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,context_key,kind)
    DO UPDATE SET pruned_count=pruned_count+excluded.pruned_count,
    pruned_through=max(coalesce(pruned_through,''),coalesce(excluded.pruned_through,'')),recorded_at=excluded.recorded_at`)
    .run(context.projectId, context.contextKey, kind, count, through || null, new Date().toISOString());
}
