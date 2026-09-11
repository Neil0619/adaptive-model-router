import { statSync } from "node:fs";
import { payloadHash } from "./io.mjs";
import { openPrivateState, sealPrivateState } from "./private-state.mjs";
import { readStableRollout, resolveRolloutPath } from "./native-rollout-reader.mjs";

const prefix = "global_reservation_release:";
const contentProofs = new Map(); // Process-local, stat-bound, no business state writes.
export const GLOBAL_PENDING_LIMIT = 10;

// A reservation is accounting, not a successful outcome or a host Stop. Keep
// the original gate and all business evidence until their own closure occurs.
export function reservationSnapshot(db, attempt) {
  const withoutClock = (row) => row && Object.fromEntries(Object.entries(row)
    .filter(([key]) => !["created_at", "updated_at", "observed_at"].includes(key)));
  return {
    attempt: withoutClock(attempt),
    child: withoutClock(db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(attempt.route_id)),
    messages: db.prepare("SELECT * FROM delegation_messages WHERE route_id=? ORDER BY revision").all(attempt.route_id).map(withoutClock),
    commands: db.prepare("SELECT * FROM delegation_child_commands WHERE route_id=? ORDER BY call_id").all(attempt.route_id).map(withoutClock),
  };
}

export function sourceFingerprint(path) {
  const actual = resolveRolloutPath(path), s = statSync(actual);
  if (!s.isFile()) throw new Error("reservation evidence is not a regular file");
  return { path, digest: payloadHash([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]) };
}

export function readReservationRelease(db, routeId) {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(prefix + routeId);
  if (!row) return null;
  const release = JSON.parse(openPrivateState(db, row.value));
  if (release.schemaVersion !== 1 || release.routeId !== routeId || !release.basis
    || !["operator_deferral", "verified_deferral", "verified_terminal"].includes(release.kind)
    || !Array.isArray(release.sources) || !release.snapshot) throw new Error("reservation release record is invalid");
  return release;
}

function executionDigest(snapshot) {
  const a = snapshot.attempt;
  return payloadHash({ identity: a.finalized_at || a.maintenance_only ? { route_id: a.route_id, maintenance: true } : Object.fromEntries(["route_id", "ticket_consumed", "root_turn_id", "tool_use_id",
    "dispatch_input_digest", "post_observed", "agent_id", "early_agent_id", "ambiguous"].map((key) => [key, a[key]])),
    child: snapshot.child && [snapshot.child.task_hash, snapshot.child.agent_hash],
    messages: snapshot.messages.filter((message) => message.kind !== "interrupt_agent"),
    commands: snapshot.commands.map(({ verified: _verified, ...command }) => command) });
}

export function reservationIsReleased(db, attempt, { deadline = Date.now() + 150 } = {}) {
  try {
    if (attempt.maintenance_only && attempt.ownership_state !== "settled") return false;
    const release = readReservationRelease(db, attempt.route_id);
    if (!release) return false;
    const resumed = db.prepare("SELECT value FROM meta WHERE key=?").get(`global_reservation_resume:${attempt.route_id}`);
    if (resumed?.value === payloadHash(release)) return false;
    const childPath = release.snapshot.child && JSON.parse(openPrivateState(db, release.snapshot.child.locator)).transcriptPath;
    return executionDigest(release.snapshot) === executionDigest(reservationSnapshot(db, attempt))
      && release.sources.filter((source) => source.path === childPath).every((source) => {
        const current = sourceFingerprint(source.path).digest;
        if (current === source.digest) return true;
        // Archive/restore and metadata-only changes are not execution. The
        // complete saved content hash also binds the original session identity.
        if (!release.retained?.transcriptDigest) return false;
        const key = payloadHash([source.path, current, release.retained.transcriptDigest]);
        if (contentProofs.has(key)) return true;
        if (readStableRollout(source.path, () => {}, { deadline }).transcriptDigest !== release.retained.transcriptDigest) return false;
        if (contentProofs.size >= 256) contentProofs.delete(contentProofs.keys().next().value);
        contentProofs.set(key, true);
        return true;
      });
  } catch { return false; } // New or unreadable execution evidence charges the slot again.
}

export function reacquireReservation(db, routeId) {
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(routeId);
  const release = readReservationRelease(db, routeId);
  if (attempt && !attempt.finalized_at && !release) return true;
  if (!db.isTransaction) throw new Error("reservation resumption requires a write transaction");
  if (!attempt || attempt.finalized_at) {
    if (!attempt && !maintenanceOwner(db, routeId)) return false;
    const maintenance = db.prepare("SELECT * FROM delegation_maintenance WHERE route_id=? AND state='active'").get(routeId);
    if (!maintenance) return false;
    if (reservationInventory(db).pending.filter((row) => row.route_id !== routeId).length >= GLOBAL_PENDING_LIMIT) return false;
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`global_maintenance_reservation:${routeId}`, String(maintenance.start_revision));
    if (release) db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`global_reservation_resume:${routeId}`, payloadHash(release));
    return true;
  }
  if (!release) return true;
  const resumed = db.prepare("SELECT value FROM meta WHERE key=?").get(`global_reservation_resume:${routeId}`);
  if (resumed?.value === payloadHash(release)) return true;
  // Changed/unknown evidence charges this route conservatively, but is never
  // proof that resumption passed admission. Count other owners before granting.
  if (reservationInventory(db).pending.filter((row) => row.route_id !== routeId).length >= GLOBAL_PENDING_LIMIT) return false;
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`global_reservation_resume:${routeId}`, payloadHash(release));
  return true;
}

// Terminal attempts are bounded history; trusted settled children outlive that
// trimming. Model their maintenance ownership explicitly, without inventing a
// startup ticket, Stop, or business attempt.
function maintenanceOwner(db, routeId, { requireSettled = true } = {}) {
  const child = db.prepare(`SELECT c.route_id,c.project_id,c.context_key,c.created_at,c.state AS ownership_state FROM delegation_children c
    JOIN routes r ON r.route_id=c.route_id WHERE c.route_id=?`).get(routeId);
  return child && (!requireSettled || child.ownership_state === "settled") ? { ...child, maintenance_only: true } : null;
}

export function reservationInventory(db, { deadline = Date.now() + 150 } = {}) {
  const attempts = db.prepare("SELECT * FROM delegation_attempts WHERE finalized_at IS NULL ORDER BY created_at,route_id").all();
  // A completed business stage may need a fresh bounded collection. Its old
  // outcome stays immutable; charge only the maintenance execution generation.
  for (const maintenance of db.prepare("SELECT route_id,start_revision FROM delegation_maintenance WHERE state='active'").all()) {
    const row = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(maintenance.route_id);
    if (row && !row.finalized_at) continue;
    const held = db.prepare("SELECT value FROM meta WHERE key=?").get(`global_maintenance_reservation:${maintenance.route_id}`);
    if (held?.value === String(maintenance.start_revision)) {
      const owner = row || maintenanceOwner(db, maintenance.route_id, { requireSettled: false });
      if (owner) attempts.push(owner);
    }
  }
  let verificationDeferred = 0;
  const released = attempts.filter((row) => {
    if (Date.now() > deadline) { verificationDeferred++; return false; }
    return reservationIsReleased(db, row, { deadline });
  });
  const ids = new Set(released.map((row) => row.route_id));
  return { pending: attempts.filter((row) => !ids.has(row.route_id)), released, verificationDeferred };
}

export function saveReservationRelease(db, attempt, { kind, basis, requesterContextId, sources = [], expectedSources = [], lastActivity = null, retained = null }) {
  if (!db.isTransaction) throw new Error("reservation release requires a write transaction");
  const activeMaintenance = attempt && db.prepare("SELECT 1 FROM delegation_maintenance WHERE route_id=? AND state='active'").get(attempt.route_id);
  if (!attempt || ((attempt.finalized_at || attempt.maintenance_only) && !activeMaintenance) || !basis || !requesterContextId) throw new Error("reservation release needs an open attempt or active maintenance and explicit basis");
  if (!["operator_deferral", "verified_deferral", "verified_terminal"].includes(kind)) throw new Error("invalid reservation disposition");
  if (!attempt.maintenance_only && !attempt.ticket_consumed) throw new Error("An unconsumed ticket must retain its reservation until native recovery.");
  const fingerprints = sources.map(sourceFingerprint);
  if (payloadHash(fingerprints) !== payloadHash(expectedSources)) throw new Error("Reservation evidence changed after verification.");
  const previous = readReservationRelease(db, attempt.route_id);
  if (previous && reservationIsReleased(db, attempt) && (!retained || previous.retained?.finals?.length)) return { released: true, idempotent: true, routeId: attempt.route_id };
  const snapshot = reservationSnapshot(db, attempt);
  let originalStage = previous?.retained?.originalStage;
  if (typeof originalStage !== "string" || !originalStage) {
    try { originalStage = openPrivateState(db, attempt.context_package); }
    catch { originalStage = { unreadable: true, source: "preserved encrypted attempt.context_package" }; }
  }
  const release = { schemaVersion: 1, routeId: attempt.route_id, kind, basis, requesterContextId,
    recordedAt: new Date().toISOString(), lastActivity, sources: fingerprints,
    stateDigest: payloadHash(snapshot), snapshot,
    retained: { ...retained, originalStage },
    outcome: db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(attempt.route_id) || null,
    previousDigest: previous ? payloadHash(previous) : null };
  if (previous) db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)")
    .run(`${prefix}history:${attempt.route_id}:${payloadHash(previous)}`, sealPrivateState(db, JSON.stringify(previous)));
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(prefix + attempt.route_id, sealPrivateState(db, JSON.stringify(release)));
  return { released: true, idempotent: false, routeId: attempt.route_id, kind };
}

export function reservationStatus(db, context) {
  const inventory = reservationInventory(db);
  const owned = db.prepare(`SELECT route_id FROM routes WHERE project_id=? AND context_key=? AND
    (route_id IN (SELECT route_id FROM delegation_attempts WHERE finalized_at IS NULL)
      OR route_id IN (SELECT route_id FROM delegation_maintenance WHERE state='active'))`)
    .all(context.projectId, context.contextKey);
  return { limit: GLOBAL_PENDING_LIMIT, pending: inventory.pending.length, released: inventory.released.length,
    verificationDeferred: inventory.verificationDeferred,
    retained: owned.flatMap(({ route_id }) => {
      try {
        const release = readReservationRelease(db, route_id);
        return release ? [{ routeId: route_id, kind: release.kind, recordedAt: release.recordedAt,
          nextAction: "read_disposition_then_collect_and_verify_original_stage", gateRetained: true }] : [];
      } catch { return [{ routeId: route_id, nextAction: "restore_unreadable_reservation_disposition", gateRetained: true }]; }
    }) };
}
