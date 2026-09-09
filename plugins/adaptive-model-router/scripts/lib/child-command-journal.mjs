import { payloadHash } from "./io.mjs";

export const isChildCommand = (input) => input?.tool_name === "Bash";
const present = (value) => typeof value === "string" && value.trim().length > 0;

export function createChildCommandSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_child_commands (
    route_id TEXT NOT NULL REFERENCES delegation_children(route_id) ON DELETE CASCADE,
    call_id TEXT NOT NULL, command_digest TEXT NOT NULL, start_turn_id TEXT,
    pre_seen INTEGER NOT NULL DEFAULT 0 CHECK(pre_seen IN (0,1)),
    post_seen INTEGER NOT NULL DEFAULT 0 CHECK(post_seen IN (0,1)),
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK(conflicted IN (0,1)),
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
    PRIMARY KEY(route_id,call_id)
  );
  CREATE TRIGGER IF NOT EXISTS require_child_command_closure BEFORE INSERT ON outcomes
    WHEN EXISTS (SELECT 1 FROM delegation_child_commands c WHERE c.route_id=NEW.route_id
      AND c.verified=0)
    BEGIN SELECT RAISE(ABORT, 'managed command outcome requires current operation verification'); END`);
}

/** Called only after the Hook has resolved the native managed-child identity.
 * A Bash Post means execution ended, not that its business result passed. A
 * later write_stdin turn retains the original command call ID, not its turn ID.
 * Keep digests only: command lines and output can contain credentials. */
export function observeChildCommand(db, routeId, input, { post = false } = {}) {
  if (!isChildCommand(input)) return { matched: false };
  if (!present(input.tool_use_id) || !present(input.turn_id)
    || typeof input.tool_input?.command !== "string" || (post && typeof input.tool_response !== "string")) {
    throw new Error("Native command identity or result is incomplete.");
  }
  const key = [routeId, input.tool_use_id];
  const digest = payloadHash(input.tool_input.command);
  const previous = db.prepare("SELECT * FROM delegation_child_commands WHERE route_id=? AND call_id=?").get(...key);
  if (previous && (previous.command_digest !== digest
    || (!post && previous.pre_seen && previous.start_turn_id !== input.turn_id))) {
    db.prepare("UPDATE delegation_child_commands SET conflicted=1,verified=0 WHERE route_id=? AND call_id=?").run(...key);
    return { matched: true, allowed: false, reason: "Native command receipts conflict; preserve the original operation for reconciliation." };
  }
  db.prepare(`INSERT INTO delegation_child_commands(route_id,call_id,command_digest,start_turn_id,pre_seen,post_seen)
    VALUES(?,?,?,?,?,?) ON CONFLICT(route_id,call_id) DO UPDATE SET
      verified=CASE WHEN delegation_child_commands.pre_seen < excluded.pre_seen
        OR delegation_child_commands.post_seen < excluded.post_seen THEN 0 ELSE delegation_child_commands.verified END,
      start_turn_id=COALESCE(delegation_child_commands.start_turn_id,excluded.start_turn_id),
      pre_seen=MAX(delegation_child_commands.pre_seen,excluded.pre_seen),
      post_seen=MAX(delegation_child_commands.post_seen,excluded.post_seen)`)
    .run(...key, digest, post ? null : input.turn_id, post ? 0 : 1, post ? 1 : 0);
  return { matched: true, allowed: post || (!previous?.post_seen && !previous?.conflicted),
    reason: "This native command call already ended; do not execute it again." };
}

export function readChildCommands(db, routeId) {
  return db.prepare("SELECT * FROM delegation_child_commands WHERE route_id=? ORDER BY call_id").all(routeId)
    .map((row) => ({ callId: row.call_id, commandDigest: row.command_digest, turnId: row.start_turn_id,
      started: row.pre_seen === 1, terminal: row.post_seen === 1, conflicted: row.conflicted === 1 }));
}
