import { spawnSync } from "node:child_process";
import { payloadHash } from "./io.mjs";
import { readChildTurnEvidence } from "./child-turn-evidence.mjs";
import { readChildCommands } from "./child-command-journal.mjs";
import { openPrivateState } from "./private-state.mjs";
import { pendingRuntimeResponsibilities } from "./runtime-isolation.mjs";

const proofs = new WeakMap();
export function nativeProcessInventory() {
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"] : ["-axo", "pid=,command="];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error("Native process inventory is unavailable; cold transition is unproven");
  if (process.platform === "win32") {
    const rows = JSON.parse(result.stdout);
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({ pid: row.ProcessId, executable: row.CommandLine || row.ExecutablePath || row.Name }));
  }
  return result.stdout.trim().split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) throw new Error("Native process inventory is incomplete");
    return { pid: Number(match[1]), executable: match[2] };
  });
}

function legacySnapshot(db) {
  return payloadHash(["routes", "delegation_attempts", "delegation_children", "delegation_messages", "delegation_child_commands", "delegation_maintenance", "outcomes", "meta"]
    .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

// The executable inspector is replaceable only for isolated unit fixtures;
// runtime-admin has no flag for supplying a claimed process list or passed proof.
export function inspectColdRuntimeTransition(db, { inventory = nativeProcessInventory, preserveLegacy = false } = {}) {
  const processes = inventory();
  assertColdProcessInventory(processes);
  const scopes = preserveLegacy ? [] : db.prepare("SELECT DISTINCT project_id,context_key FROM delegation_attempts UNION SELECT project_id,context_key FROM delegation_children").all();
  for (const scope of scopes) {
    if (pendingRuntimeResponsibilities(db, { projectId: scope.project_id, contextKey: scope.context_key }).length) {
      throw new Error("Cold transition retains unfinished/unknown legacy responsibility; finish its native lifecycle first");
    }
  }
  for (const child of preserveLegacy ? [] : db.prepare("SELECT * FROM delegation_children").all()) {
    const locator = JSON.parse(openPrivateState(db, child.locator));
    const facts = readChildTurnEvidence(locator, { commands: readChildCommands(db, child.route_id) });
    if (!facts.finished || facts.pendingOperations.length || !facts.lastFinal
      || !db.prepare("SELECT 1 FROM delegation_child_stops WHERE route_id=? AND turn_id=? AND result_digest=?")
        .get(child.route_id, facts.lastFinal.turnId, facts.lastFinal.digest)) {
      throw new Error("Legacy child native retirement is unproven; do not discard its history");
    }
  }
  const proof = Object.freeze({ historyDigest: legacySnapshot(db), processDigest: payloadHash(processes), preserveLegacy });
  proofs.set(proof, { db, digest: proof.historyDigest, preserveLegacy });
  return proof;
}

export function assertColdProcessInventory(processes = nativeProcessInventory()) {
  if (!Array.isArray(processes) || processes.some((row) => !Number.isSafeInteger(row.pid) || typeof row.executable !== "string")
    || processes.some((row) => row.pid !== process.pid && /(?:^|[\\/ ])codex(?:\.exe)?(?:\s|$)|Codex\.app[\\/]|(?:node-launcher|mcp-server)\.mjs/iu.test(row.executable))) {
    throw new Error("Cold bootstrap requires native Codex hosts to be stopped; no live legacy writer may remain");
  }
  return processes;
}
export function validColdRuntimeTransition(db, proof, preserveLegacy = false) {
  const saved = proofs.get(proof);
  return saved?.db === db && saved.digest === legacySnapshot(db) && saved.preserveLegacy === preserveLegacy;
}
