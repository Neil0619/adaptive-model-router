import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  DATABASE_VERSION,
  DEFAULT_OFFSETS,
  DEFAULT_SCORING_PROFILE,
  DEFAULT_SETTINGS,
  EFFORT_ORDER,
  HOST_MODEL_INTENT_DECISIONS,
  ROUTER_VERSION,
  STORAGE_CONTRACT_VERSION,
} from "./constants.mjs";
import { databasePath, legacyStatePresent, opaqueId, projectIdentityMaterial } from "./context.mjs";
import { canonicalJson, isSqliteBusy, parseJson, payloadHash, sleepSync } from "./io.mjs";
import { normalizeModelSlug } from "./model-slug.mjs";

const GLOBAL_PROJECT = "__global__";
const GLOBAL_CONTEXT = "__global__";
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const STORAGE_CONTRACT_SCHEMA = Object.freeze({
  meta: ["key", "value"],
  projects: ["project_id", "created_at"],
  settings: ["scope", "project_id", "key", "value_json", "updated_at"],
  overrides: ["id", "scope", "project_id", "context_key", "mode", "model", "effort", "created_at"],
  routes: [
    "route_id", "project_id", "context_key", "schema_version", "action", "category", "model",
    "effort", "family", "root_model", "verification_gate", "reason_codes_json",
    "classifier_state", "escalation_count", "previous_route_id", "created_at",
  ],
  outcomes: [
    "seq", "route_id", "project_id", "context_key", "category", "status", "gate",
    "failure_type", "retries", "escalations", "user_correction", "payload_hash", "recorded_at",
    "retry_reasoning", "retry_environment", "retry_information", "retry_tooling",
  ],
  stop_observations: ["project_id", "context_key", "route_id", "reminded_at", "resolved_at"],
  policy_revisions: [
    "revision_id", "project_id", "parent_revision_id", "offsets_json", "outcome_seq",
    "proposal_id", "created_at",
  ],
  project_policy: ["project_id", "active_revision_id"],
  learning_cursors: ["project_id", "category", "last_outcome_seq"],
  policy_proposals: [
    "proposal_id", "project_id", "category", "delta", "base_revision_id", "start_seq",
    "end_seq", "eligible_count", "affected_count", "status", "created_at", "decided_at",
    "context_count", "failure_count", "correction_count", "reasoning_retry_count",
    "base_profile_id", "kind",
  ],
  classifier_health: [
    "project_id", "context_key", "consecutive_failures", "opened_until", "updated_at",
  ],
  catalog_cache: ["cache_key", "models_json", "fetched_at"],
  host_model_changes: [
    "change_id", "project_id", "context_key", "from_model", "to_model", "status",
    "detected_at", "resolved_at",
  ],
  host_model_state: [
    "project_id", "context_key", "current_model", "model_visible", "task_mode",
    "pending_change_id", "updated_at",
  ],
  scoring_profiles: [
    "profile_id", "project_id", "parent_profile_id", "profile_version", "definition_json",
    "source", "outcome_seq", "created_at",
  ],
  project_scoring_profile: [
    "project_id", "active_profile_id", "last_safe_profile_id", "updated_at",
  ],
  route_score_snapshots: [
    "route_id", "project_id", "context_key", "profile_id", "base_score", "final_score",
    "category", "signals_json", "policy_offset", "classifier_adjustment", "hard_signal_count",
    "desired_family", "desired_effort", "eligible_learning", "exclusion_codes_json", "created_at",
  ],
  learning_events: [
    "event_id", "project_id", "event_type", "profile_id", "details_json", "created_at",
  ],
});
function nowIso() {
  return new Date().toISOString();
}

export function normalizeRootModel(value) {
  return normalizeModelSlug(value);
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
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.trunc(timeout))}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA trusted_schema = OFF");
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
    if (version > DATABASE_VERSION) {
      this.assertStorageContract();
      this.forwardDatabaseVersion = version;
      return;
    }
    if (version === DATABASE_VERSION) {
      const columns = this.db.prepare("PRAGMA table_info(host_model_state)").all();
      if (columns.length && !columns.some((column) => column.name === "model_visible")) {
        this.transaction(() => {
          this.db.exec("ALTER TABLE host_model_state ADD COLUMN model_visible INTEGER NOT NULL DEFAULT 0 CHECK (model_visible IN (0, 1))");
          this.db.exec("UPDATE host_model_state SET model_visible = CASE WHEN current_model IS NULL THEN 0 ELSE 1 END");
        });
      }
      return;
    }
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
            root_model TEXT,
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
          CREATE TABLE IF NOT EXISTS host_model_changes (
            change_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            from_model TEXT NOT NULL,
            to_model TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'manual_root', 'keep_automatic', 'cancelled', 'superseded')),
            detected_at TEXT NOT NULL,
            resolved_at TEXT
          );
          CREATE INDEX IF NOT EXISTS host_model_changes_context
            ON host_model_changes(project_id, context_key, detected_at DESC);
          CREATE UNIQUE INDEX IF NOT EXISTS one_pending_host_model_change
            ON host_model_changes(project_id, context_key) WHERE status = 'pending';
          CREATE TABLE IF NOT EXISTS host_model_state (
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            current_model TEXT,
            model_visible INTEGER NOT NULL DEFAULT 0 CHECK (model_visible IN (0, 1)),
            task_mode TEXT NOT NULL CHECK (task_mode IN ('automatic', 'manual_root')),
            pending_change_id TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, context_key)
          );
        `);
      }
      if (current === 1) {
        this.db.exec(`
          ALTER TABLE routes ADD COLUMN root_model TEXT;
          CREATE TABLE IF NOT EXISTS host_model_changes (
            change_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            from_model TEXT NOT NULL,
            to_model TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'manual_root', 'keep_automatic', 'cancelled', 'superseded')),
            detected_at TEXT NOT NULL,
            resolved_at TEXT
          );
          CREATE INDEX IF NOT EXISTS host_model_changes_context
            ON host_model_changes(project_id, context_key, detected_at DESC);
          CREATE UNIQUE INDEX IF NOT EXISTS one_pending_host_model_change
            ON host_model_changes(project_id, context_key) WHERE status = 'pending';
          CREATE TABLE IF NOT EXISTS host_model_state (
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            current_model TEXT,
            model_visible INTEGER NOT NULL DEFAULT 0 CHECK (model_visible IN (0, 1)),
            task_mode TEXT NOT NULL CHECK (task_mode IN ('automatic', 'manual_root')),
            pending_change_id TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, context_key)
          );
        `);
      }
      if (current <= 2) {
        const hostColumns = this.db.prepare("PRAGMA table_info(host_model_state)").all();
        if (hostColumns.length && !hostColumns.some((column) => column.name === "model_visible")) {
          this.db.exec("ALTER TABLE host_model_state ADD COLUMN model_visible INTEGER NOT NULL DEFAULT 0 CHECK (model_visible IN (0, 1))");
          this.db.exec("UPDATE host_model_state SET model_visible = CASE WHEN current_model IS NULL THEN 0 ELSE 1 END");
        }
        this.db.exec(`
          ALTER TABLE outcomes ADD COLUMN retry_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (retry_reasoning >= 0);
          ALTER TABLE outcomes ADD COLUMN retry_environment INTEGER NOT NULL DEFAULT 0 CHECK (retry_environment >= 0);
          ALTER TABLE outcomes ADD COLUMN retry_information INTEGER NOT NULL DEFAULT 0 CHECK (retry_information >= 0);
          ALTER TABLE outcomes ADD COLUMN retry_tooling INTEGER NOT NULL DEFAULT 0 CHECK (retry_tooling >= 0);
          ALTER TABLE policy_proposals ADD COLUMN context_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE policy_proposals ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE policy_proposals ADD COLUMN correction_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE policy_proposals ADD COLUMN reasoning_retry_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE policy_proposals ADD COLUMN base_profile_id TEXT;
          ALTER TABLE policy_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'offset'
            CHECK (kind IN ('offset', 'rebase'));
          CREATE TABLE IF NOT EXISTS scoring_profiles (
            profile_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_profile_id TEXT,
            profile_version INTEGER NOT NULL CHECK (profile_version > 0),
            definition_json TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('baseline', 'offline_reanchor')),
            outcome_seq INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE (project_id, profile_version)
          );
          CREATE TABLE IF NOT EXISTS project_scoring_profile (
            project_id TEXT PRIMARY KEY,
            active_profile_id TEXT NOT NULL REFERENCES scoring_profiles(profile_id),
            last_safe_profile_id TEXT REFERENCES scoring_profiles(profile_id),
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS route_score_snapshots (
            route_id TEXT PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            context_key TEXT NOT NULL,
            profile_id TEXT NOT NULL REFERENCES scoring_profiles(profile_id),
            base_score INTEGER NOT NULL CHECK (base_score BETWEEN 0 AND 100),
            final_score INTEGER NOT NULL CHECK (final_score BETWEEN 0 AND 100),
            category TEXT NOT NULL,
            signals_json TEXT NOT NULL,
            policy_offset INTEGER NOT NULL,
            classifier_adjustment INTEGER NOT NULL,
            hard_signal_count INTEGER NOT NULL CHECK (hard_signal_count >= 0),
            desired_family TEXT NOT NULL,
            desired_effort TEXT NOT NULL,
            eligible_learning INTEGER NOT NULL CHECK (eligible_learning IN (0, 1)),
            exclusion_codes_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS route_score_learning
            ON route_score_snapshots(project_id, category, eligible_learning);
          CREATE TABLE IF NOT EXISTS learning_events (
            event_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            event_type TEXT NOT NULL CHECK (event_type IN (
              'profile_reanchored', 'proposal_rebased', 'safety_auto_rollback'
            )),
            profile_id TEXT,
            details_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS learning_events_project
            ON learning_events(project_id, created_at DESC);
        `);
      }
      this.db.exec(`PRAGMA user_version = ${DATABASE_VERSION}`);
    });
  }

  assertStorageContract() {
    for (const [table, requiredColumns] of Object.entries(STORAGE_CONTRACT_SCHEMA)) {
      const columns = new Set(
        this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
      );
      if (requiredColumns.some((column) => !columns.has(column))) {
        throw new Error("router database storage contract is incompatible");
      }
    }
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

  context({ cwd = process.cwd(), contextId, authoritative = false, create = true }) {
    if (typeof contextId !== "string" || !contextId.trim()) throw new Error("contextId is required");
    const normalizedContextId = contextId.normalize("NFC");
    if (!authoritative) {
      const observed = this.db.prepare(`
        SELECT project_id, context_key
        FROM host_model_state
        ORDER BY updated_at DESC
      `).all().find((row) => (
        opaqueId(this.salt, "context", `${row.project_id}\0${normalizedContextId}`) === row.context_key
      ));
      if (observed) return { projectId: observed.project_id, contextKey: observed.context_key };
    }
    let material = this.identityCache.get(cwd);
    if (!material) {
      material = projectIdentityMaterial(cwd);
      this.identityCache.set(cwd, material);
    }
    const projectId = opaqueId(this.salt, "project", material);
    const contextKey = opaqueId(this.salt, "context", `${projectId}\0${normalizedContextId}`);
    if (create) {
      this.db.prepare("INSERT OR IGNORE INTO projects(project_id, created_at) VALUES(?, ?)").run(projectId, nowIso());
    }
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

  hostModelState(context) {
    const row = this.db.prepare(`
      SELECT current_model, model_visible, task_mode, pending_change_id
      FROM host_model_state WHERE project_id = ? AND context_key = ?
    `).get(context.projectId, context.contextKey);
    const pending = row?.pending_change_id ? this.db.prepare(`
      SELECT change_id, from_model, to_model, status, detected_at, resolved_at
      FROM host_model_changes
      WHERE change_id = ? AND project_id = ? AND context_key = ?
    `).get(row.pending_change_id, context.projectId, context.contextKey) : null;
    return {
      currentModel: row?.current_model || null,
      modelVisible: row?.model_visible === 1,
      taskMode: pending?.status === "pending" ? "pending_confirmation" : row?.task_mode || "automatic",
      pendingChange: pending ? {
        changeId: pending.change_id,
        fromModel: pending.from_model,
        toModel: pending.to_model,
        detectedAt: pending.detected_at,
      } : null,
    };
  }

  rootTask(context, model = null) {
    const state = this.hostModelState(context);
    const supplied = normalizeRootModel(model);
    const observed = supplied || (state.modelVisible ? state.currentModel : null);
    return {
      modelVisibility: observed ? "hook_observed" : "host_managed",
      ...(observed ? { model: observed } : {}),
      reasoningEffortVisibility: "host_only",
      changedByRouter: false,
    };
  }

  observeHostModel(context, value, { detectChanges = true } = {}) {
    const model = normalizeRootModel(value);
    if (!model) {
      this.transaction(() => {
        this.db.prepare(`
          UPDATE host_model_state SET model_visible = 0, updated_at = ?
          WHERE project_id = ? AND context_key = ?
        `).run(nowIso(), context.projectId, context.contextKey);
      });
      return { observed: false, changed: false, ...this.hostModelState(context) };
    }
    return this.transaction(() => {
      const timestamp = nowIso();
      const row = this.db.prepare(`
        SELECT current_model, model_visible, task_mode, pending_change_id
        FROM host_model_state WHERE project_id = ? AND context_key = ?
      `).get(context.projectId, context.contextKey);
      if (!row) {
        this.db.prepare(`
          INSERT INTO host_model_state(project_id, context_key, current_model, model_visible, task_mode, pending_change_id, updated_at)
          VALUES(?, ?, ?, 1, 'automatic', NULL, ?)
        `).run(context.projectId, context.contextKey, model, timestamp);
        return { observed: true, changed: false, currentModel: model, taskMode: "automatic", pendingChange: null };
      }
      if (!row.current_model) {
        this.db.prepare(`
          UPDATE host_model_state SET current_model = ?, model_visible = 1, updated_at = ?
          WHERE project_id = ? AND context_key = ?
        `).run(model, timestamp, context.projectId, context.contextKey);
        return { observed: true, changed: false, ...this.hostModelState(context) };
      }
      if (row.current_model === model) {
        if (row.model_visible !== 1) {
          this.db.prepare(`
            UPDATE host_model_state SET model_visible = 1, updated_at = ?
            WHERE project_id = ? AND context_key = ?
          `).run(timestamp, context.projectId, context.contextKey);
        }
        const state = this.hostModelState(context);
        return { observed: true, changed: false, ...state };
      }
      if (!detectChanges || row.task_mode === "manual_root") {
        this.db.prepare(`
          UPDATE host_model_state SET current_model = ?, model_visible = 1, updated_at = ?
          WHERE project_id = ? AND context_key = ?
        `).run(model, timestamp, context.projectId, context.contextKey);
        return { observed: true, changed: true, ...this.hostModelState(context) };
      }

      let origin = row.current_model;
      if (row.pending_change_id) {
        const previous = this.db.prepare(`
          SELECT from_model FROM host_model_changes
          WHERE change_id = ? AND project_id = ? AND context_key = ? AND status = 'pending'
        `).get(row.pending_change_id, context.projectId, context.contextKey);
        if (previous) origin = previous.from_model;
        if (model === origin) {
          this.db.prepare(`
            UPDATE host_model_changes SET status = 'cancelled', resolved_at = ?
            WHERE change_id = ? AND project_id = ? AND context_key = ? AND status = 'pending'
          `).run(timestamp, row.pending_change_id, context.projectId, context.contextKey);
          this.db.prepare(`
            UPDATE host_model_state
            SET current_model = ?, model_visible = 1, task_mode = 'automatic', pending_change_id = NULL, updated_at = ?
            WHERE project_id = ? AND context_key = ?
          `).run(model, timestamp, context.projectId, context.contextKey);
          return { observed: true, changed: true, currentModel: model, taskMode: "automatic", pendingChange: null };
        }
        this.db.prepare(`
          UPDATE host_model_changes SET status = 'superseded', resolved_at = ?
          WHERE change_id = ? AND project_id = ? AND context_key = ? AND status = 'pending'
        `).run(timestamp, row.pending_change_id, context.projectId, context.contextKey);
      }

      const changeId = randomUUID();
      this.db.prepare(`
        INSERT INTO host_model_changes(change_id, project_id, context_key, from_model, to_model, status, detected_at, resolved_at)
        VALUES(?, ?, ?, ?, ?, 'pending', ?, NULL)
      `).run(changeId, context.projectId, context.contextKey, origin, model, timestamp);
      this.db.prepare(`
        UPDATE host_model_state
        SET current_model = ?, model_visible = 1, task_mode = 'automatic', pending_change_id = ?, updated_at = ?
        WHERE project_id = ? AND context_key = ?
      `).run(model, changeId, timestamp, context.projectId, context.contextKey);
      return {
        observed: true,
        changed: true,
        currentModel: model,
        taskMode: "pending_confirmation",
        pendingChange: { changeId, fromModel: origin, toModel: model, detectedAt: timestamp },
      };
    });
  }

  setTaskMode(context, mode) {
    if (!["automatic", "manual_root"].includes(mode)) throw new Error("task mode must be automatic or manual_root");
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT current_model, pending_change_id FROM host_model_state
        WHERE project_id = ? AND context_key = ?
      `).get(context.projectId, context.contextKey);
      const timestamp = nowIso();
      if (!row) {
        this.db.prepare(`
          INSERT INTO host_model_state(project_id, context_key, current_model, model_visible, task_mode, pending_change_id, updated_at)
          VALUES(?, ?, NULL, 0, ?, NULL, ?)
        `).run(context.projectId, context.contextKey, mode, timestamp);
        return { taskMode: mode, pendingChange: null, currentModel: null };
      }
      if (row.pending_change_id) {
        this.db.prepare(`
          UPDATE host_model_changes SET status = ?, resolved_at = ?
          WHERE change_id = ? AND project_id = ? AND context_key = ? AND status = 'pending'
        `).run(mode === "manual_root" ? "manual_root" : "keep_automatic", timestamp,
          row.pending_change_id, context.projectId, context.contextKey);
      }
      this.db.prepare(`
        UPDATE host_model_state SET task_mode = ?, pending_change_id = NULL, updated_at = ?
        WHERE project_id = ? AND context_key = ?
      `).run(mode, timestamp, context.projectId, context.contextKey);
      return { taskMode: mode, pendingChange: null, currentModel: row.current_model };
    });
  }

  cancelPendingHostModelIntent(context) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT current_model, pending_change_id FROM host_model_state
        WHERE project_id = ? AND context_key = ?
      `).get(context.projectId, context.contextKey);
      if (!row?.pending_change_id) return this.hostModelState(context);
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE host_model_changes SET status = 'cancelled', resolved_at = ?
        WHERE change_id = ? AND project_id = ? AND context_key = ? AND status = 'pending'
      `).run(timestamp, row.pending_change_id, context.projectId, context.contextKey);
      this.db.prepare(`
        UPDATE host_model_state SET pending_change_id = NULL, updated_at = ?
        WHERE project_id = ? AND context_key = ?
      `).run(timestamp, context.projectId, context.contextKey);
      return this.hostModelState(context);
    });
  }

  resolveHostModelIntent(context, { changeId, decision }) {
    if (!HOST_MODEL_INTENT_DECISIONS.includes(decision)) throw new Error("unsupported host-model intent decision");
    return this.transaction(() => {
      const change = this.db.prepare(`
        SELECT status, from_model, to_model FROM host_model_changes
        WHERE change_id = ? AND project_id = ? AND context_key = ?
      `).get(changeId, context.projectId, context.contextKey);
      if (!change) throw new Error("changeId does not belong to the current project and context");
      const state = this.db.prepare(`
        SELECT task_mode, pending_change_id FROM host_model_state
        WHERE project_id = ? AND context_key = ?
      `).get(context.projectId, context.contextKey);
      if (["manual_root", "keep_automatic"].includes(change.status)) {
        const latest = this.db.prepare(`
          SELECT change_id FROM host_model_changes
          WHERE project_id = ? AND context_key = ? ORDER BY rowid DESC LIMIT 1
        `).get(context.projectId, context.contextKey);
        const expectedMode = change.status === "manual_root" ? "manual_root" : "automatic";
        if (latest?.change_id !== changeId || state?.pending_change_id || state?.task_mode !== expectedMode) {
          throw new Error("host-model intent is stale");
        }
        if (change.status !== decision) throw new Error("host-model intent already has a conflicting decision");
        return { resolved: false, idempotent: true, decision, taskMode: decision === "manual_root" ? "manual_root" : "automatic" };
      }
      if (change.status !== "pending") throw new Error("host-model intent is stale");
      if (state?.pending_change_id !== changeId) throw new Error("host-model intent is stale");
      const taskMode = decision === "manual_root" ? "manual_root" : "automatic";
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE host_model_changes SET status = ?, resolved_at = ? WHERE change_id = ?
      `).run(decision, timestamp, changeId);
      this.db.prepare(`
        UPDATE host_model_state SET task_mode = ?, pending_change_id = NULL, updated_at = ?
        WHERE project_id = ? AND context_key = ?
      `).run(taskMode, timestamp, context.projectId, context.contextKey);
      return {
        resolved: true,
        idempotent: false,
        decision,
        taskMode,
        rootModel: change.to_model,
      };
    });
  }

  overrideKeys(context, scope) {
    if (scope === "global") return { projectId: GLOBAL_PROJECT, contextKey: GLOBAL_CONTEXT };
    if (scope === "project") return { projectId: context.projectId, contextKey: GLOBAL_CONTEXT };
    return context;
  }

  setOverride(context, { scope, mode = "locked", model = null, effort = null }) {
    const normalizedModel = model == null ? null : normalizeModelSlug(model);
    if (model != null && !normalizedModel) throw new Error("model has an invalid format");
    const keys = this.overrideKeys(context, scope);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO overrides(scope, project_id, context_key, mode, model, effort, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, project_id, context_key) DO UPDATE SET
          mode = excluded.mode, model = excluded.model, effort = excluded.effort, created_at = excluded.created_at
      `).run(scope, keys.projectId, keys.contextKey, mode, normalizedModel, effort, nowIso());
    });
    return { scope, mode, model: normalizedModel, effort };
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
          root_model, verification_gate, reason_codes_json, classifier_state, escalation_count, previous_route_id, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        route.rootTask?.model || null,
        route.verificationGate,
        canonicalJson(route.reasonCodes),
        route.classifier.state,
        route.escalation.count,
        route.previousRouteId || null,
        nowIso(),
      );
      if (route.scoringSnapshot) {
        const snapshot = route.scoringSnapshot;
        this.db.prepare(`
          INSERT INTO route_score_snapshots(
            route_id, project_id, context_key, profile_id, base_score, final_score,
            category, signals_json, policy_offset, classifier_adjustment,
            hard_signal_count, desired_family, desired_effort, eligible_learning,
            exclusion_codes_json, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          route.routeId,
          context.projectId,
          context.contextKey,
          snapshot.profileId,
          snapshot.baseScore,
          snapshot.finalScore,
          route.category,
          canonicalJson(snapshot.signals),
          snapshot.policyOffset,
          snapshot.classifierAdjustment,
          snapshot.hardSignalCount,
          snapshot.desiredFamily,
          snapshot.desiredEffort,
          snapshot.eligibleLearning ? 1 : 0,
          canonicalJson(snapshot.exclusionCodes),
          nowIso(),
        );
      }
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
        r.root_model,
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
        o.retry_reasoning AS outcome_retry_reasoning,
        o.retry_environment AS outcome_retry_environment,
        o.retry_information AS outcome_retry_information,
        o.retry_tooling AS outcome_retry_tooling,
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
        rootTask: {
          modelVisibility: row.root_model ? "hook_observed" : "host_managed",
          ...(row.root_model ? { model: row.root_model } : {}),
          reasoningEffortVisibility: "host_only",
          changedByRouter: false,
        },
        createdAt: row.created_at,
        outcome: row.outcome_status ? {
          status: row.outcome_status,
          gate: row.outcome_gate,
          failureType: row.outcome_failure_type || null,
          retries: Number(row.outcome_retries || 0),
          retryBreakdown: {
            reasoning: Number(row.outcome_retry_reasoning || 0),
            environment: Number(row.outcome_retry_environment || 0),
            information: Number(row.outcome_retry_information || 0),
            tooling: Number(row.outcome_retry_tooling || 0),
          },
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
      rootTask: this.rootTask(context),
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
      retryBreakdown: outcome.retryBreakdown,
      escalations: outcome.escalations,
      userCorrection: outcome.userCorrection,
    };
    const hash = payloadHash(normalized);
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT status, gate, failure_type, retries, retry_reasoning,
               retry_environment, retry_information, retry_tooling,
               escalations, user_correction, payload_hash
        FROM outcomes WHERE route_id = ?
      `).get(route.route_id);
      if (existing) {
        const fieldsMatch = existing.status === normalized.status
          && existing.gate === normalized.gate
          && (existing.failure_type || null) === normalized.failureType
          && Number(existing.retries) === normalized.retries
          && Number(existing.retry_reasoning) === normalized.retryBreakdown.reasoning
          && Number(existing.retry_environment) === normalized.retryBreakdown.environment
          && Number(existing.retry_information) === normalized.retryBreakdown.information
          && Number(existing.retry_tooling) === normalized.retryBreakdown.tooling
          && Number(existing.escalations) === normalized.escalations
          && (existing.user_correction === 1) === normalized.userCorrection;
        if (existing.payload_hash !== hash && !fieldsMatch) {
          const error = new Error("routeId already has a conflicting final outcome");
          error.code = "OUTCOME_CONFLICT";
          throw error;
        }
        return { recorded: false, idempotent: true, status: normalized.status };
      }
      const result = this.db.prepare(`
        INSERT INTO outcomes(
          route_id, project_id, context_key, category, status, gate, failure_type,
          retries, retry_reasoning, retry_environment, retry_information, retry_tooling,
          escalations, user_correction, payload_hash, recorded_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        route.route_id,
        context.projectId,
        context.contextKey,
        route.category,
        normalized.status,
        normalized.gate,
        normalized.failureType,
        normalized.retries,
        normalized.retryBreakdown.reasoning,
        normalized.retryBreakdown.environment,
        normalized.retryBreakdown.information,
        normalized.retryBreakdown.tooling,
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
          retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
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

  ensureScoringProfile(context) {
    return this.transaction(() => {
      let current = this.db.prepare(`
        SELECT
          s.active_profile_id,
          s.last_safe_profile_id,
          p.parent_profile_id,
          p.profile_version,
          p.definition_json,
          p.source,
          p.outcome_seq,
          p.created_at
        FROM project_scoring_profile s
        JOIN scoring_profiles p ON p.profile_id = s.active_profile_id
        WHERE s.project_id = ?
      `).get(context.projectId);
      if (!current) {
        const profileId = randomUUID();
        const timestamp = nowIso();
        this.db.prepare(`
          INSERT INTO scoring_profiles(
            profile_id, project_id, parent_profile_id, profile_version,
            definition_json, source, outcome_seq, created_at
          ) VALUES(?, ?, NULL, ?, ?, 'baseline', 0, ?)
        `).run(
          profileId,
          context.projectId,
          DEFAULT_SCORING_PROFILE.profileVersion,
          canonicalJson(DEFAULT_SCORING_PROFILE),
          timestamp,
        );
        this.db.prepare(`
          INSERT INTO project_scoring_profile(
            project_id, active_profile_id, last_safe_profile_id, updated_at
          ) VALUES(?, ?, NULL, ?)
        `).run(context.projectId, profileId, timestamp);
        current = {
          active_profile_id: profileId,
          last_safe_profile_id: null,
          parent_profile_id: null,
          profile_version: DEFAULT_SCORING_PROFILE.profileVersion,
          definition_json: canonicalJson(DEFAULT_SCORING_PROFILE),
          source: "baseline",
          outcome_seq: 0,
          created_at: timestamp,
        };
      }
      const parsedDefinition = parseJson(current.definition_json, DEFAULT_SCORING_PROFILE);
      return {
        profileId: current.active_profile_id,
        parentProfileId: current.parent_profile_id || null,
        lastSafeProfileId: current.last_safe_profile_id || null,
        profileVersion: Number(current.profile_version),
        definition: {
          weights: { ...DEFAULT_SCORING_PROFILE.weights, ...(parsedDefinition.weights || {}) },
          thresholds: { ...DEFAULT_SCORING_PROFILE.thresholds, ...(parsedDefinition.thresholds || {}) },
        },
        source: current.source,
        outcomeSeq: Number(current.outcome_seq || 0),
        createdAt: current.created_at,
      };
    });
  }

  peekScoringProfile(context) {
    const current = this.db.prepare(`
      SELECT
        s.active_profile_id,
        s.last_safe_profile_id,
        p.parent_profile_id,
        p.profile_version,
        p.definition_json,
        p.source,
        p.outcome_seq,
        p.created_at
      FROM project_scoring_profile s
      JOIN scoring_profiles p ON p.profile_id = s.active_profile_id
      WHERE s.project_id = ?
    `).get(context.projectId);
    if (!current) {
      return {
        profileId: null,
        parentProfileId: null,
        lastSafeProfileId: null,
        profileVersion: DEFAULT_SCORING_PROFILE.profileVersion,
        definition: {
          weights: { ...DEFAULT_SCORING_PROFILE.weights },
          thresholds: { ...DEFAULT_SCORING_PROFILE.thresholds },
        },
        source: "baseline",
        outcomeSeq: 0,
        createdAt: null,
      };
    }
    const parsedDefinition = parseJson(current.definition_json, DEFAULT_SCORING_PROFILE);
    return {
      profileId: current.active_profile_id,
      parentProfileId: current.parent_profile_id || null,
      lastSafeProfileId: current.last_safe_profile_id || null,
      profileVersion: Number(current.profile_version),
      definition: {
        weights: { ...DEFAULT_SCORING_PROFILE.weights, ...(parsedDefinition.weights || {}) },
        thresholds: { ...DEFAULT_SCORING_PROFILE.thresholds, ...(parsedDefinition.thresholds || {}) },
      },
      source: current.source,
      outcomeSeq: Number(current.outcome_seq || 0),
      createdAt: current.created_at,
    };
  }

  reanchorScoringProfile(context, { profileVersion, definition }) {
    const active = this.ensureScoringProfile(context);
    if (!Number.isInteger(profileVersion) || profileVersion <= active.profileVersion) {
      throw new Error("profileVersion must be greater than the active scoring profile version");
    }
    return this.transaction(() => {
      const current = this.db.prepare(`
        SELECT s.active_profile_id, p.profile_version
        FROM project_scoring_profile s
        JOIN scoring_profiles p ON p.profile_id = s.active_profile_id
        WHERE s.project_id = ?
      `).get(context.projectId);
      if (!current || current.active_profile_id !== active.profileId) {
        throw new Error("active scoring profile changed; retry the reanchor");
      }
      if (Number(current.profile_version) >= profileVersion) {
        throw new Error("profileVersion must be greater than the active scoring profile version");
      }
      const timestamp = nowIso();
      const profileId = randomUUID();
      const outcomeSeq = Number(this.db.prepare(`
        SELECT coalesce(max(seq), 0) AS seq FROM outcomes WHERE project_id = ?
      `).get(context.projectId).seq || 0);
      this.db.prepare(`
        INSERT INTO scoring_profiles(
          profile_id, project_id, parent_profile_id, profile_version,
          definition_json, source, outcome_seq, created_at
        ) VALUES(?, ?, ?, ?, ?, 'offline_reanchor', ?, ?)
      `).run(
        profileId,
        context.projectId,
        active.profileId,
        profileVersion,
        canonicalJson({ ...definition, profileVersion }),
        outcomeSeq,
        timestamp,
      );
      const pending = this.db.prepare(`
        SELECT category, end_seq FROM policy_proposals
        WHERE project_id = ? AND status = 'pending'
      `).all(context.projectId);
      for (const proposal of pending) {
        this.db.prepare(`
          INSERT INTO learning_cursors(project_id, category, last_outcome_seq)
          VALUES(?, ?, ?)
          ON CONFLICT(project_id, category) DO UPDATE SET
            last_outcome_seq = max(last_outcome_seq, excluded.last_outcome_seq)
        `).run(context.projectId, proposal.category, Number(proposal.end_seq));
      }
      this.db.prepare(`
        UPDATE policy_proposals SET status = 'stale', decided_at = ?
        WHERE project_id = ? AND status = 'pending'
      `).run(timestamp, context.projectId);
      this.db.prepare(`
        UPDATE project_scoring_profile
        SET active_profile_id = ?, last_safe_profile_id = ?, updated_at = ?
        WHERE project_id = ?
      `).run(profileId, active.profileId, timestamp, context.projectId);
      this.db.prepare(`
        INSERT INTO learning_events(
          event_id, project_id, event_type, profile_id, details_json, created_at
        ) VALUES(?, ?, 'profile_reanchored', ?, ?, ?)
      `).run(
        randomUUID(),
        context.projectId,
        profileId,
        canonicalJson({ fromVersion: active.profileVersion, toVersion: profileVersion }),
        timestamp,
      );
      return {
        profileId,
        parentProfileId: active.profileId,
        profileVersion,
        source: "offline_reanchor",
        staleProposals: pending.length,
      };
    });
  }

  enforceScoringSafety(context, route) {
    return this.transaction(() => {
      const snapshot = this.db.prepare(`
        SELECT profile_id, signals_json
        FROM route_score_snapshots
        WHERE route_id = ? AND project_id = ? AND context_key = ?
      `).get(route.route_id, context.projectId, context.contextKey);
      if (!snapshot) return { checked: false, rolledBack: false };
      const signals = parseJson(snapshot.signals_json, {});
      const safetySensitive = signals.risk === true || signals.security === true || signals.migration === true;
      const effortStrongEnough = EFFORT_ORDER.indexOf(route.effort) >= EFFORT_ORDER.indexOf("high");
      const targetSafe = !safetySensitive || (route.family === "sol" && effortStrongEnough);
      if (targetSafe) return { checked: true, rolledBack: false };
      const state = this.db.prepare(`
        SELECT active_profile_id FROM project_scoring_profile WHERE project_id = ?
      `).get(context.projectId);
      const profile = this.db.prepare(`
        SELECT parent_profile_id, profile_version FROM scoring_profiles
        WHERE profile_id = ? AND project_id = ?
      `).get(snapshot.profile_id, context.projectId);
      if (!profile?.parent_profile_id || state?.active_profile_id !== snapshot.profile_id) {
        return { checked: true, rolledBack: false, violation: true };
      }
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE project_scoring_profile
        SET active_profile_id = ?, last_safe_profile_id = NULL, updated_at = ?
        WHERE project_id = ?
      `).run(profile.parent_profile_id, timestamp, context.projectId);
      const categoryWindows = this.db.prepare(`
        SELECT category, max(seq) AS end_seq
        FROM outcomes
        WHERE project_id = ?
        GROUP BY category
      `).all(context.projectId);
      for (const window of categoryWindows) {
        this.db.prepare(`
          INSERT INTO learning_cursors(project_id, category, last_outcome_seq)
          VALUES(?, ?, ?)
          ON CONFLICT(project_id, category) DO UPDATE SET
            last_outcome_seq = max(last_outcome_seq, excluded.last_outcome_seq)
        `).run(context.projectId, window.category, Number(window.end_seq || 0));
      }
      this.db.prepare(`
        INSERT INTO learning_events(
          event_id, project_id, event_type, profile_id, details_json, created_at
        ) VALUES(?, ?, 'safety_auto_rollback', ?, ?, ?)
      `).run(
        randomUUID(),
        context.projectId,
        snapshot.profile_id,
        canonicalJson({ violated: "risk_floor", fromVersion: Number(profile.profile_version) }),
        timestamp,
      );
      return {
        checked: true,
        rolledBack: true,
        violation: true,
        fromProfileId: snapshot.profile_id,
        toProfileId: profile.parent_profile_id,
      };
    });
  }

  learningStatus(context) {
    const profile = this.ensureScoringProfile(context);
    const policy = this.ensurePolicy(context);
    const outcomes = this.db.prepare(`
      SELECT
        count(*) AS total,
        coalesce(sum(CASE WHEN s.route_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS snapshotted,
        coalesce(sum(CASE
          WHEN s.eligible_learning = 1
            AND o.status != 'unknown'
            AND (o.failure_type IS NULL OR o.failure_type = 'reasoning')
            AND o.retry_environment = 0
            AND o.retry_information = 0
            AND o.retry_tooling = 0
          THEN 1 ELSE 0 END), 0) AS route_eligible
      FROM outcomes o
      LEFT JOIN route_score_snapshots s ON s.route_id = o.route_id
      WHERE o.project_id = ?
    `).get(context.projectId);
    const exclusions = this.db.prepare(`
      SELECT exclusion_codes_json, count(*) AS count
      FROM route_score_snapshots
      WHERE project_id = ? AND eligible_learning = 0
      GROUP BY exclusion_codes_json
      ORDER BY count(*) DESC, exclusion_codes_json
    `).all(context.projectId).map((row) => ({
      reasonCodes: parseJson(row.exclusion_codes_json, []),
      count: Number(row.count),
    }));
    const proposals = this.db.prepare(`
      SELECT proposal_id, category, delta, status, eligible_count, affected_count,
             context_count, failure_count, correction_count, reasoning_retry_count,
             base_revision_id, base_profile_id, kind, created_at
      FROM policy_proposals
      WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 20
    `).all(context.projectId).map((row) => ({
      proposalId: row.proposal_id,
      category: row.category,
      delta: Number(row.delta),
      status: row.status,
      eligibleCount: Number(row.eligible_count),
      affectedCount: Number(row.affected_count),
      contextCount: Number(row.context_count),
      failureCount: Number(row.failure_count),
      correctionCount: Number(row.correction_count),
      reasoningRetryCount: Number(row.reasoning_retry_count),
      baseRevisionId: row.base_revision_id,
      baseProfileId: row.base_profile_id || null,
      kind: row.kind || "offset",
      createdAt: row.created_at,
    }));
    const events = this.db.prepare(`
      SELECT event_type, profile_id, details_json, created_at
      FROM learning_events
      WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 20
    `).all(context.projectId).map((row) => ({
      type: row.event_type,
      profileId: row.profile_id || null,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
    return {
      routerVersion: ROUTER_VERSION,
      projectKey: context.projectId.slice(0, 12),
      scope: "current_project",
      scoringProfile: profile,
      policy: {
        revisionId: policy.revisionId,
        categoryOffsets: policy.categoryOffsets,
      },
      evidence: {
        outcomes: Number(outcomes.total || 0),
        snapshotted: Number(outcomes.snapshotted || 0),
        routeEligible: Number(outcomes.route_eligible || 0),
        exclusions,
      },
      proposals,
      events,
    };
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

  peekPolicy(context) {
    const current = this.db.prepare(`
      SELECT p.active_revision_id, r.parent_revision_id, r.offsets_json, r.outcome_seq
      FROM project_policy p JOIN policy_revisions r ON r.revision_id = p.active_revision_id
      WHERE p.project_id = ?
    `).get(context.projectId);
    if (!current) {
      return {
        revisionId: null,
        parentRevisionId: null,
        categoryOffsets: { ...DEFAULT_OFFSETS },
        outcomeSeq: 0,
      };
    }
    return {
      revisionId: current.active_revision_id,
      parentRevisionId: current.parent_revision_id,
      categoryOffsets: { ...DEFAULT_OFFSETS, ...parseJson(current.offsets_json, {}) },
      outcomeSeq: Number(current.outcome_seq || 0),
    };
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
    const hostState = this.hostModelState(context);
    const disabledByOverride = this.resolveOverride(context, null, settings).override?.mode === "disabled";
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
      rootTask: latest.rootTask,
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
      rootTask: this.rootTask(context),
      taskMode: hostState.taskMode,
      pendingHostModelChange: hostState.pendingChange,
      autoActivation: {
        globalEnabled: settings.autoActivate === true,
        effective: settings.autoActivate === true && settings.enabled === true && !disabledByOverride,
      },
      currentStage: hostState.taskMode === "pending_confirmation"
        ? { state: "pending_model_intent", target: null, since: hostState.pendingChange?.detectedAt || null }
        : hostState.taskMode === "manual_root"
          ? { state: "manual_root", target: null, since: null }
          : !latest
        ? { state: "no_route", target: null, since: null }
        : latest.action === "delegate" && latest.outcome == null
          ? { state: "delegated_pending_outcome", target: latest.target, since: latest.createdAt }
          : latest.action === "ask_user"
            ? { state: "awaiting_user", target: null, since: latest.createdAt }
            : { state: "root", target: null, since: latest.outcome?.recordedAt || latest.createdAt },
      settings,
      policy: { revisionId: policy.revisionId, categoryOffsets: policy.categoryOffsets },
      scoringProfile: (() => {
        const profile = this.ensureScoringProfile(context);
        return {
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
          source: profile.source,
        };
      })(),
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
      supportedDatabaseVersion: DATABASE_VERSION,
      storageContractVersion: STORAGE_CONTRACT_VERSION,
      databaseCompatibility: this.forwardDatabaseVersion ? "forward_compatible" : "native",
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
      this.db.prepare("DELETE FROM route_score_snapshots WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM routes WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM learning_events WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM policy_proposals WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM learning_cursors WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project_policy WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM policy_revisions WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project_scoring_profile WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM scoring_profiles WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM classifier_health WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM legacy_imports WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM host_model_changes WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM host_model_state WHERE project_id = ?").run(projectId);
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
