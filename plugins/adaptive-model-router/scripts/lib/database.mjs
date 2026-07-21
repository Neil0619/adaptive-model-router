import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  DATABASE_VERSION,
  DEFAULT_OFFSETS,
  DEFAULT_SETTINGS,
  EFFORT_ORDER,
  ROUTER_VERSION,
} from "./constants.mjs";
import { databasePath, legacyStatePresent, opaqueId, projectIdentityMaterial } from "./context.mjs";
import { canonicalJson, isSqliteBusy, parseJson, payloadHash, sleepSync } from "./io.mjs";

const GLOBAL_PROJECT = "__global__";
const GLOBAL_CONTEXT = "__global__";
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

function nowIso() {
  return new Date().toISOString();
}

function sqliteOptions(timeout) {
  return {
    timeout,
    enableForeignKeyConstraints: true,
    allowExtension: false,
    defensive: true,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  };
}

export class RouterStore {
  constructor({ path = databasePath(), timeout = 5_000 } = {}) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, sqliteOptions(timeout));
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ACLs are inherited from the user's Codex data directory.
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA trusted_schema = OFF");
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(timeout))}`);
    this.migrate();
    this.salt = this.getOrCreateSalt();
    this.identityCache = new Map();
  }

  close() {
    if (!this.db) return;
    if (this.db.isTransaction) this.db.exec("ROLLBACK");
    this.db.close();
    this.db = null;
  }

  transaction(callback, { attempts = 5 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const value = callback();
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        lastError = error;
        if (this.db.isTransaction) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            // The original error is more useful and is rethrown below.
          }
        }
        if (!isSqliteBusy(error) || attempt === attempts - 1) throw error;
        sleepSync(12 * (attempt + 1) + Math.floor(Math.random() * 18));
      }
    }
    throw lastError;
  }

  migrate() {
    const version = Number(this.db.prepare("PRAGMA user_version").get().user_version || 0);
    if (version > DATABASE_VERSION) throw new Error("router database was created by a newer version");
    if (version === DATABASE_VERSION) return;
    this.transaction(() => {
      const current = Number(this.db.prepare("PRAGMA user_version").get().user_version || 0);
      if (current === 0) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS projects (
            project_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS settings (
            scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
            project_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, project_id, key)
          );
          CREATE TABLE IF NOT EXISTS overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL CHECK (scope IN ('once', 'session', 'project', 'global')),
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('locked', 'disabled')),
            model TEXT,
            effort TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (scope, project_id, context_key)
          );
          CREATE TABLE IF NOT EXISTS routes (
            route_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('delegate', 'continue', 'ask_user')),
            category TEXT NOT NULL,
            model TEXT,
            effort TEXT,
            family TEXT,
            verification_gate TEXT NOT NULL,
            reason_codes_json TEXT NOT NULL,
            classifier_state TEXT NOT NULL,
            escalation_count INTEGER NOT NULL DEFAULT 0,
            previous_route_id TEXT,
            created_at TEXT NOT NULL,
            CHECK ((action = 'delegate' AND model IS NOT NULL AND effort IS NOT NULL) OR
                   (action != 'delegate' AND model IS NULL AND effort IS NULL))
          );
          CREATE INDEX IF NOT EXISTS routes_context_created
            ON routes(project_id, context_key, created_at DESC);
          CREATE TABLE IF NOT EXISTS outcomes (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            route_id TEXT NOT NULL UNIQUE REFERENCES routes(route_id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            category TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'unknown')),
            gate TEXT NOT NULL,
            failure_type TEXT,
            retries INTEGER NOT NULL CHECK (retries >= 0),
            escalations INTEGER NOT NULL CHECK (escalations >= 0),
            user_correction INTEGER NOT NULL CHECK (user_correction IN (0, 1)),
            payload_hash TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            CHECK ((status = 'failed' AND failure_type IS NOT NULL) OR
                   (status != 'failed' AND failure_type IS NULL))
          );
          CREATE INDEX IF NOT EXISTS outcomes_learning
            ON outcomes(project_id, category, seq);
          CREATE TABLE IF NOT EXISTS stop_observations (
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            route_id TEXT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
            reminded_at TEXT NOT NULL,
            resolved_at TEXT,
            PRIMARY KEY (project_id, context_key, route_id)
          );
          CREATE TABLE IF NOT EXISTS policy_revisions (
            revision_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_revision_id TEXT,
            offsets_json TEXT NOT NULL,
            outcome_seq INTEGER NOT NULL DEFAULT 0,
            proposal_id TEXT,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS project_policy (
            project_id TEXT PRIMARY KEY,
            active_revision_id TEXT NOT NULL REFERENCES policy_revisions(revision_id)
          );
          CREATE TABLE IF NOT EXISTS learning_cursors (
            project_id TEXT NOT NULL,
            category TEXT NOT NULL,
            last_outcome_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (project_id, category)
          );
          CREATE TABLE IF NOT EXISTS policy_proposals (
            proposal_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            category TEXT NOT NULL,
            delta INTEGER NOT NULL CHECK (delta IN (-5, 5)),
            base_revision_id TEXT NOT NULL,
            start_seq INTEGER NOT NULL,
            end_seq INTEGER NOT NULL,
            eligible_count INTEGER NOT NULL,
            affected_count INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale')),
            created_at TEXT NOT NULL,
            decided_at TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS one_pending_proposal
            ON policy_proposals(project_id, category) WHERE status = 'pending';
          CREATE TABLE IF NOT EXISTS classifier_health (
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            opened_until INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, context_key)
          );
          CREATE TABLE IF NOT EXISTS catalog_cache (
            cache_key TEXT PRIMARY KEY,
            models_json TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS legacy_imports (
            project_id TEXT PRIMARY KEY,
            settings_imported INTEGER NOT NULL CHECK (settings_imported IN (0, 1)),
            policy_imported INTEGER NOT NULL CHECK (policy_imported IN (0, 1)),
            history_records_archived INTEGER NOT NULL DEFAULT 0,
            imported_at TEXT NOT NULL
          );
        `);
      }
      this.db.exec(`PRAGMA user_version = ${DATABASE_VERSION}`);
    });
  }

  getOrCreateSalt() {
    return this.transaction(() => {
      let row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("local_salt");
      if (!row) {
        const value = randomBytes(32).toString("base64url");
        this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)").run("local_salt", value);
        row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("local_salt");
      }
      return row.value;
    });
  }

  context({ cwd = process.cwd(), contextId }) {
    if (typeof contextId !== "string" || !contextId.trim()) throw new Error("contextId is required");
    let material = this.identityCache.get(cwd);
    if (!material) {
      material = projectIdentityMaterial(cwd);
      this.identityCache.set(cwd, material);
    }
    const projectId = opaqueId(this.salt, "project", material);
    const contextKey = opaqueId(this.salt, "context", `${projectId}\0${contextId.normalize("NFC")}`);
    this.db.prepare("INSERT OR IGNORE INTO projects(project_id, created_at) VALUES(?, ?)").run(projectId, nowIso());
    return { projectId, contextKey };
  }

  getSettings(context) {
    const settings = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare(`
      SELECT scope, key, value_json FROM settings
      WHERE (scope = 'global' AND project_id = ?) OR (scope = 'project' AND project_id = ?)
      ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END
    `).all(GLOBAL_PROJECT, context.projectId);
    for (const row of rows) settings[row.key] = parseJson(row.value_json, settings[row.key]);
    return settings;
  }

  configure(context, changes, scope = "project") {
    const projectId = scope === "global" ? GLOBAL_PROJECT : context.projectId;
    this.transaction(() => {
      const statement = this.db.prepare(`
        INSERT INTO settings(scope, project_id, key, value_json, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(scope, project_id, key) DO UPDATE SET
          value_json = excluded.value_json, updated_at = excluded.updated_at
      `);
      for (const [key, value] of Object.entries(changes)) {
        statement.run(scope, projectId, key, canonicalJson(value), nowIso());
      }
    });
    return this.getSettings(context);
  }

  overrideKeys(context, scope) {
    if (scope === "global") return { projectId: GLOBAL_PROJECT, contextKey: GLOBAL_CONTEXT };
    if (scope === "project") return { projectId: context.projectId, contextKey: GLOBAL_CONTEXT };
    return context;
  }

  setOverride(context, { scope, mode = "locked", model = null, effort = null }) {
    const keys = this.overrideKeys(context, scope);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO overrides(scope, project_id, context_key, mode, model, effort, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, project_id, context_key) DO UPDATE SET
          mode = excluded.mode, model = excluded.model, effort = excluded.effort, created_at = excluded.created_at
      `).run(scope, keys.projectId, keys.contextKey, mode, model, effort, nowIso());
    });
    return { scope, mode, model, effort };
  }

  clearOverrides(context, scope = "all") {
    return this.transaction(() => {
      let changes = 0;
      const scopes = scope === "all" ? ["once", "session", "project", "global"] : [scope];
      for (const candidate of scopes) {
        const keys = this.overrideKeys(context, candidate);
        changes += Number(this.db.prepare(
          "DELETE FROM overrides WHERE scope = ? AND project_id = ? AND context_key = ?",
        ).run(candidate, keys.projectId, keys.contextKey).changes);
      }
      return { cleared: changes };
    });
  }

  resolveOverride(context, requestOverride = null, settings = this.getSettings(context)) {
    if (requestOverride) return { source: "request", override: requestOverride, onceId: null };
    const rows = [
      ["once", context.projectId, context.contextKey],
      ["session", context.projectId, context.contextKey],
      ["project", context.projectId, GLOBAL_CONTEXT],
      ...(settings.allowGlobalOverride ? [["global", GLOBAL_PROJECT, GLOBAL_CONTEXT]] : []),
    ];
    for (const [scope, projectId, contextKey] of rows) {
      const row = this.db.prepare(`
        SELECT id, mode, model, effort FROM overrides
        WHERE scope = ? AND project_id = ? AND context_key = ?
      `).get(scope, projectId, contextKey);
      if (row) return { source: scope, override: { mode: row.mode, model: row.model, effort: row.effort }, onceId: scope === "once" ? row.id : null };
    }
    return { source: null, override: null, onceId: null };
  }

  commitRoute(context, route, onceId = null) {
    return this.transaction(() => {
      if (onceId != null) {
        const row = this.db.prepare(`
          SELECT id FROM overrides WHERE id = ? AND scope = 'once' AND project_id = ? AND context_key = ?
        `).get(onceId, context.projectId, context.contextKey);
        if (!row) return { committed: false, retry: true };
        this.db.prepare("DELETE FROM overrides WHERE id = ?").run(onceId);
      }
      this.db.prepare(`
        INSERT INTO routes(
          route_id, project_id, context_key, schema_version, action, category, model, effort, family,
          verification_gate, reason_codes_json, classifier_state, escalation_count, previous_route_id, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        route.routeId,
        context.projectId,
        context.contextKey,
        route.schemaVersion,
        route.action,
        route.category,
        route.target?.model || null,
        route.target?.effort || null,
        route.family || null,
        route.verificationGate,
        canonicalJson(route.reasonCodes),
        route.classifier.state,
        route.escalation.count,
        route.previousRouteId || null,
        nowIso(),
      );
      return { committed: true, retry: false };
    });
  }

  findRoute(context, routeId) {
    return this.db.prepare(`
      SELECT * FROM routes WHERE route_id = ? AND project_id = ? AND context_key = ?
    `).get(routeId, context.projectId, context.contextKey) || null;
  }

  routeHistory(context, { limit = DEFAULT_HISTORY_LIMIT, action = "all" } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      throw new Error(`history limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}`);
    }
    if (!["all", "delegate", "continue", "ask_user"].includes(action)) {
      throw new Error("history action must be all, delegate, continue, or ask_user");
    }
    const actionClause = action === "all" ? "" : "AND r.action = ?";
    const parameters = action === "all"
      ? [context.projectId, context.contextKey, limit]
      : [context.projectId, context.contextKey, action, limit];
    const rows = this.db.prepare(`
      SELECT
        r.rowid AS route_sequence,
        r.route_id,
        r.action,
        r.category,
        r.model,
        r.effort,
        r.verification_gate,
        r.reason_codes_json,
        r.classifier_state,
        r.escalation_count,
        r.previous_route_id,
        r.created_at,
        o.status AS outcome_status,
        o.gate AS outcome_gate,
        o.failure_type AS outcome_failure_type,
        o.retries AS outcome_retries,
        o.escalations AS outcome_escalations,
        o.user_correction AS outcome_user_correction,
        o.recorded_at AS outcome_recorded_at
      FROM routes r
      LEFT JOIN outcomes o ON o.route_id = r.route_id
      WHERE r.project_id = ? AND r.context_key = ? ${actionClause}
      ORDER BY r.rowid DESC
      LIMIT ?
    `).all(...parameters);
    const previousDelegate = this.db.prepare(`
      SELECT model, effort
      FROM routes
      WHERE project_id = ? AND context_key = ? AND action = 'delegate' AND rowid < ?
      ORDER BY rowid DESC
      LIMIT 1
    `);
    const routes = rows.map((row) => {
      const target = row.model ? { model: row.model, effort: row.effort } : null;
      let transition = { state: "not_delegated" };
      if (target) {
        const prior = previousDelegate.get(context.projectId, context.contextKey, row.route_sequence);
        if (!prior) {
          transition = { state: "initial_delegate", to: target };
        } else {
          const from = { model: prior.model, effort: prior.effort };
          transition = {
            state: from.model === target.model && from.effort === target.effort
              ? "target_unchanged"
              : "target_changed",
            from,
            to: target,
          };
        }
      }
      return {
        routeId: row.route_id,
        action: row.action,
        category: row.category,
        ...(target ? { target } : {}),
        transition,
        reasonCodes: parseJson(row.reason_codes_json, []),
        verificationGate: row.verification_gate,
        classifier: { state: row.classifier_state },
        escalation: { count: Number(row.escalation_count || 0) },
        previousRouteId: row.previous_route_id || null,
        createdAt: row.created_at,
        outcome: row.outcome_status ? {
          status: row.outcome_status,
          gate: row.outcome_gate,
          failureType: row.outcome_failure_type || null,
          retries: Number(row.outcome_retries || 0),
          escalations: Number(row.outcome_escalations || 0),
          userCorrection: row.outcome_user_correction === 1,
          recordedAt: row.outcome_recorded_at,
        } : null,
      };
    });
    return {
      routerVersion: ROUTER_VERSION,
      projectKey: context.projectId.slice(0, 12),
      contextKey: context.contextKey.slice(0, 12),
      scope: "current_project_context",
      rootTask: { modelVisibility: "host_managed", changedByRouter: false },
      filter: { action, limit },
      routes,
    };
  }

  insertOutcome(context, route, outcome) {
    const normalized = {
      status: outcome.status,
      gate: outcome.gate,
      failureType: outcome.failureType ?? null,
      retries: outcome.retries,
      escalations: outcome.escalations,
      userCorrection: outcome.userCorrection,
    };
    const hash = payloadHash(normalized);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_hash FROM outcomes WHERE route_id = ?").get(route.route_id);
      if (existing) {
        if (existing.payload_hash !== hash) {
          const error = new Error("routeId already has a conflicting final outcome");
          error.code = "OUTCOME_CONFLICT";
          throw error;
        }
        return { recorded: false, idempotent: true, status: normalized.status };
      }
      const result = this.db.prepare(`
        INSERT INTO outcomes(
          route_id, project_id, context_key, category, status, gate, failure_type,
          retries, escalations, user_correction, payload_hash, recorded_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        route.route_id,
        context.projectId,
        context.contextKey,
        route.category,
        normalized.status,
        normalized.gate,
        normalized.failureType,
        normalized.retries,
        normalized.escalations,
        normalized.userCorrection ? 1 : 0,
        hash,
        nowIso(),
      );
      return { recorded: true, idempotent: false, status: normalized.status, seq: Number(result.lastInsertRowid) };
    });
  }

  handleStop(context, stopHookActive) {
    return this.transaction(() => {
      const pending = this.db.prepare(`
        SELECT r.* FROM routes r
        LEFT JOIN outcomes o ON o.route_id = r.route_id
        WHERE r.project_id = ? AND r.context_key = ? AND r.action = 'delegate' AND o.route_id IS NULL
        ORDER BY r.rowid
      `).all(context.projectId, context.contextKey);
      if (!pending.length) return { action: "allow", recordedUnknown: 0 };
      if (!stopHookActive) {
        const statement = this.db.prepare(`
          INSERT OR IGNORE INTO stop_observations(project_id, context_key, route_id, reminded_at)
          VALUES(?, ?, ?, ?)
        `);
        for (const route of pending) statement.run(context.projectId, context.contextKey, route.route_id, nowIso());
        return { action: "block", pending: pending.length };
      }
      let recordedUnknown = 0;
      for (const route of pending) {
        const normalized = {
          status: "unknown",
          gate: route.verification_gate,
          failureType: null,
          retries: 0,
          escalations: route.escalation_count,
          userCorrection: false,
        };
        const result = this.db.prepare(`
          INSERT OR IGNORE INTO outcomes(
            route_id, project_id, context_key, category, status, gate, failure_type,
            retries, escalations, user_correction, payload_hash, recorded_at
          ) VALUES(?, ?, ?, ?, 'unknown', ?, NULL, 0, ?, 0, ?, ?)
        `).run(
          route.route_id,
          context.projectId,
          context.contextKey,
          route.category,
          route.verification_gate,
          route.escalation_count,
          payloadHash(normalized),
          nowIso(),
        );
        recordedUnknown += Number(result.changes);
        this.db.prepare(`
          UPDATE stop_observations SET resolved_at = ?
          WHERE project_id = ? AND context_key = ? AND route_id = ?
        `).run(nowIso(), context.projectId, context.contextKey, route.route_id);
      }
      return { action: "allow", recordedUnknown };
    });
  }

  ensurePolicy(context) {
    return this.transaction(() => {
      let current = this.db.prepare(`
        SELECT p.active_revision_id, r.parent_revision_id, r.offsets_json, r.outcome_seq
        FROM project_policy p JOIN policy_revisions r ON r.revision_id = p.active_revision_id
        WHERE p.project_id = ?
      `).get(context.projectId);
      if (!current) {
        const revisionId = randomUUID();
        this.db.prepare(`
          INSERT INTO policy_revisions(revision_id, project_id, parent_revision_id, offsets_json, outcome_seq, created_at)
          VALUES(?, ?, NULL, ?, 0, ?)
        `).run(revisionId, context.projectId, canonicalJson(DEFAULT_OFFSETS), nowIso());
        this.db.prepare("INSERT INTO project_policy(project_id, active_revision_id) VALUES(?, ?)")
          .run(context.projectId, revisionId);
        current = { active_revision_id: revisionId, parent_revision_id: null, offsets_json: canonicalJson(DEFAULT_OFFSETS), outcome_seq: 0 };
      }
      return {
        revisionId: current.active_revision_id,
        parentRevisionId: current.parent_revision_id,
        categoryOffsets: { ...DEFAULT_OFFSETS, ...parseJson(current.offsets_json, {}) },
        outcomeSeq: Number(current.outcome_seq || 0),
      };
    });
  }

  classifierHealth(context) {
    const row = this.db.prepare(`
      SELECT consecutive_failures, opened_until FROM classifier_health
      WHERE project_id = ? AND context_key = ?
    `).get(context.projectId, context.contextKey);
    return { failures: Number(row?.consecutive_failures || 0), openedUntil: Number(row?.opened_until || 0) };
  }

  classifierSucceeded(context) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO classifier_health(project_id, context_key, consecutive_failures, opened_until, updated_at)
        VALUES(?, ?, 0, 0, ?)
        ON CONFLICT(project_id, context_key) DO UPDATE SET
          consecutive_failures = 0, opened_until = 0, updated_at = excluded.updated_at
      `).run(context.projectId, context.contextKey, nowIso());
    });
  }

  classifierFailed(context, { limit, cooldownMs, now = Date.now() }) {
    return this.transaction(() => {
      const current = this.classifierHealth(context);
      const failures = current.failures + 1;
      const openedUntil = failures >= limit ? now + cooldownMs : 0;
      this.db.prepare(`
        INSERT INTO classifier_health(project_id, context_key, consecutive_failures, opened_until, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(project_id, context_key) DO UPDATE SET
          consecutive_failures = excluded.consecutive_failures,
          opened_until = excluded.opened_until,
          updated_at = excluded.updated_at
      `).run(context.projectId, context.contextKey, failures, openedUntil, nowIso());
      return { failures, openedUntil };
    });
  }

  cacheCatalog(models) {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO catalog_cache(cache_key, models_json, fetched_at) VALUES('models', ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET models_json = excluded.models_json, fetched_at = excluded.fetched_at
      `).run(canonicalJson(models), Date.now());
    });
  }

  cachedCatalog() {
    const row = this.db.prepare("SELECT models_json, fetched_at FROM catalog_cache WHERE cache_key = 'models'").get();
    return row ? { models: parseJson(row.models_json, []), fetchedAt: Number(row.fetched_at) } : null;
  }

  status(context) {
    const settings = this.getSettings(context);
    const policy = this.ensurePolicy(context);
    const latest = this.routeHistory(context, { limit: 1 }).routes[0] || null;
    const latestStatus = latest ? {
      routeId: latest.routeId,
      action: latest.action,
      category: latest.category,
      ...(latest.target ? { target: latest.target } : {}),
      transition: latest.transition,
      reasonCodes: latest.reasonCodes,
      verificationGate: latest.verificationGate,
      classifier: latest.classifier.state,
      escalations: latest.escalation.count,
      previousRouteId: latest.previousRouteId,
      createdAt: latest.createdAt,
      outcome: latest.outcome,
    } : null;
    const pendingProposals = Number(this.db.prepare(`
      SELECT count(*) AS count FROM policy_proposals WHERE project_id = ? AND status = 'pending'
    `).get(context.projectId).count);
    const pendingOutcomes = Number(this.db.prepare(`
      SELECT count(*) AS count FROM routes r LEFT JOIN outcomes o ON o.route_id = r.route_id
      WHERE r.project_id = ? AND r.context_key = ? AND r.action = 'delegate' AND o.route_id IS NULL
    `).get(context.projectId, context.contextKey).count);
    return {
      routerVersion: ROUTER_VERSION,
      projectKey: context.projectId.slice(0, 12),
      contextKey: context.contextKey.slice(0, 12),
      rootTask: { modelVisibility: "host_managed", changedByRouter: false },
      currentStage: !latest
        ? { state: "no_route", target: null, since: null }
        : latest.action === "delegate" && latest.outcome == null
          ? { state: "delegated_pending_outcome", target: latest.target, since: latest.createdAt }
          : latest.action === "ask_user"
            ? { state: "awaiting_user", target: null, since: latest.createdAt }
            : { state: "root", target: null, since: latest.outcome?.recordedAt || latest.createdAt },
      settings,
      policy: { revisionId: policy.revisionId, categoryOffsets: policy.categoryOffsets },
      latestRoute: latestStatus,
      pendingOutcomes,
      pendingProposals,
    };
  }

  diagnose(context) {
    const quick = this.db.prepare("PRAGMA quick_check").get();
    const health = this.classifierHealth(context);
    return {
      routerVersion: ROUTER_VERSION,
      databaseVersion: Number(this.db.prepare("PRAGMA user_version").get().user_version),
      databaseHealth: Object.values(quick)[0] === "ok" ? "ok" : "needs_attention",
      journalMode: String(Object.values(this.db.prepare("PRAGMA journal_mode").get())[0]),
      classifier: {
        failures: health.failures,
        circuitOpen: health.openedUntil > Date.now(),
      },
      legacyState: { present: legacyStatePresent(), automaticallyImported: false },
      current: this.status(context),
    };
  }

  clearProject(context) {
    return this.transaction(() => {
      const projectId = context.projectId;
      this.db.prepare("DELETE FROM outcomes WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM stop_observations WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM routes WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM policy_proposals WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM learning_cursors WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project_policy WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM policy_revisions WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM classifier_health WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM legacy_imports WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM overrides WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM settings WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
      return { cleared: true, projectKey: projectId.slice(0, 12), saltPreserved: true };
    });
  }
}

export function assertSupportedEffort(effort) {
  if (effort != null && !EFFORT_ORDER.includes(effort)) throw new Error(`unsupported effort: ${effort}`);
}
