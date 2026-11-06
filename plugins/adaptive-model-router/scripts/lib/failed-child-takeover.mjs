import { openPrivateState, sealPrivateState } from "./private-state.mjs";
import { readStableRollout } from "./native-rollout-reader.mjs";
import { requestError } from "./request-errors.mjs";

export function readFailedChildReceipt(db, routeId) {
  const row = db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND kind='terminal_failure' ORDER BY revision DESC LIMIT 1").get(routeId);
  return row ? JSON.parse(openPrivateState(db, row.record)) : null;
}

export function verifiedFailedChild(db, routeId) {
  const child = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(routeId);
  if (!child || child.verified_revision !== child.revision || !child.verified_digest) return false;
  const receipt = readFailedChildReceipt(db, routeId);
  return Boolean(receipt && receipt.revision === child.revision && receipt.token === child.verified_digest);
}

// Preserve the original task and actual partial replies before finalization
// removes the dispatch capsule. This is encrypted audit evidence, not a claim
// that either the business task or its independent review succeeded.
export function retainFailedChild(db, child, locator, closure) {
  const previous = readFailedChildReceipt(db, child.route_id);
  if (previous?.token === closure.token) return;
  const attempt = db.prepare("SELECT context_package FROM delegation_attempts WHERE route_id=?").get(child.route_id);
  let originalStage = previous?.retained.originalStage;
  if (!originalStage && attempt?.context_package) originalStage = openPrivateState(db, attempt.context_package);
  if (!originalStage) throw requestError("STAGE_PRECONDITION", "Original stage capsule is unavailable; preserve its responsibility before takeover.");
  const retained = { originalStage, inputs: [], finals: [], failures: [], transcriptPath: locator.transcriptPath };
  let bytes = Buffer.byteLength(originalStage);
  const source = readStableRollout(locator.transcriptPath, (entry) => {
    const p = entry.payload;
    const bucket = entry.type === "response_item" && p?.type === "agent_message" ? retained.inputs
      : entry.type === "response_item" && p?.type === "message" && p.role === "assistant" ? retained.finals
      : entry.type === "event_msg" && p?.type === "task_complete" && p.error ? retained.failures : null;
    if (!bucket) return;
    bytes += Buffer.byteLength(JSON.stringify(p));
    if (bytes > 1024 * 1024) throw requestError("STAGE_PRECONDITION", "Failure takeover evidence exceeds bounded storage; retain the original transcript.");
    bucket.push(p);
  }, { deadline: Date.now() + 5000 });
  if (source.transcriptDigest !== closure.transcriptDigest) throw requestError("STAGE_PRECONDITION", "Child evidence changed during failure takeover.");
  db.prepare("INSERT INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,'terminal_failure',?,?)")
    .run(child.route_id, child.revision, sealPrivateState(db, JSON.stringify({ revision: child.revision, token: closure.token,
      terminal: closure.terminalFailure, transcriptDigest: source.transcriptDigest, retained })), new Date().toISOString());
}
