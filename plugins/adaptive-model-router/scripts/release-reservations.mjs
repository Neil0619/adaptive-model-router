#!/usr/bin/env node
// Explicit operator disposition only. Automatic capacity pressure never calls
// this path, and ordinary MCP clients cannot turn missing evidence into a release.
import { readFileSync } from "node:fs";
import { RouterStore } from "./lib/database.mjs";
import { payloadHash } from "./lib/io.mjs";
import { reservationInventory, reservationSnapshot, saveReservationRelease } from "./lib/reservation-ledger.mjs";
import { inspectReclamationCandidate } from "./lib/global-reservation-reclamation.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
if (!input.contextId || !input.basis || !Array.isArray(input.routeIds) || !input.routeIds.length || input.routeIds.length > 10
  || new Set(input.routeIds).size !== input.routeIds.length || input.routeIds.some((id) => !/^[a-f0-9-]{36}$/u.test(id))
  || (input.apply !== undefined && typeof input.apply !== "boolean")) throw new Error("Supply exact routeIds, requester contextId and explicit user authorization basis.");
Object.assign(process.env, environmentWithPluginData(import.meta.url));
const store = new RouterStore();
try {
  const result = store.transaction(() => {
    const rows = input.routeIds.map((id) => {
      const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND finalized_at IS NULL").get(id);
      if (!attempt) throw new Error(`No open attempt for ${id}`);
      const view = inspectReclamationCandidate(store.db, attempt);
      if (!attempt.ticket_consumed) throw new Error("An unconsumed startup reservation requires authoritative native recovery.");
      // Explicitly named legacy records can relinquish only global accounting;
      // their unknown execution and same-task gate remain intact. Known children
      // require native idle proof; a user cancellation does not stop operations.
      if ((attempt.agent_id || attempt.early_agent_id) && !view.eligible) throw new Error(`Known child is not safely deferred: ${view.reason}`);
      const digest = payloadHash(reservationSnapshot(store.db, attempt));
      if (input.apply && input.expectedDigests?.[id] !== digest) throw new Error("Reservation changed since inspection; inspect again.");
      return { attempt, view, digest };
    });
    if (!input.apply) return { state: "reviewable", routes: rows.map(({ attempt, view, digest }) => ({ routeId: attempt.route_id,
      evidenceDigest: digest, kind: view.eligible ? view.kind : "operator_deferral", evidenceState: view.reason || "verified_idle",
      globalReservationOnly: true, originalGateRetained: true })) };
    const before = reservationInventory(store.db).pending.length;
    const releases = rows.map(({ attempt, view }) => saveReservationRelease(store.db, attempt, {
      kind: view.eligible ? view.kind : "operator_deferral", basis: input.basis, requesterContextId: input.contextId,
      sources: view.paths || [], expectedSources: view.fingerprints || [], lastActivity: view.lastActivity || null, retained: view.retained || null }));
    return { state: "released", before, after: reservationInventory(store.db).pending.length, releases,
      originalOutcomesUnchanged: true, originalGatesRetained: true };
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally { store.close(); }
