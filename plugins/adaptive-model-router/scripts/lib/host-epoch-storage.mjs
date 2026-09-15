// Additive records deliberately stay outside native_qualification:* and the
// old candidate state machine. Frozen v2 constructors neither parse nor prune
// these records. Execution generation is mutable; origin/receipts are not.
export function ensureHostEpochSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_contract_adoptions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL,
      generation TEXT NOT NULL, binding_digest TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(project_id,context_key,generation,binding_digest));
    CREATE TABLE IF NOT EXISTS runtime_epoch_publications (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, candidate TEXT NOT NULL,
      record TEXT NOT NULL, UNIQUE(source,candidate));
    CREATE TABLE IF NOT EXISTS runtime_epoch_ordinary_publications (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, candidate TEXT NOT NULL,
      record TEXT NOT NULL, UNIQUE(source,candidate));
    CREATE TABLE IF NOT EXISTS runtime_epoch_ordinary_defaults (
      writer_digest TEXT NOT NULL, shell_digest TEXT NOT NULL,
      generation TEXT NOT NULL, publication_id TEXT NOT NULL,
      PRIMARY KEY(writer_digest,shell_digest));
    CREATE TABLE IF NOT EXISTS runtime_epoch_origins (
      project_id TEXT NOT NULL, context_key TEXT NOT NULL, subject TEXT NOT NULL,
      generation TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(project_id,context_key,subject));
    CREATE TABLE IF NOT EXISTS runtime_epoch_receipts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL,
      source TEXT NOT NULL, candidate TEXT NOT NULL, previous TEXT,
      baseline_digest TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(project_id,context_key,source,candidate,baseline_digest));
    CREATE TABLE IF NOT EXISTS runtime_epoch_tasks (
      project_id TEXT NOT NULL, context_key TEXT NOT NULL, receipt_id TEXT NOT NULL,
      generation TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('checking','active')),
      PRIMARY KEY(project_id,context_key));
    CREATE TABLE IF NOT EXISTS runtime_epoch_execution (
      receipt_id TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
      invocation_id TEXT NOT NULL, generation TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(receipt_id,subject,kind,invocation_id));
    CREATE TABLE IF NOT EXISTS runtime_epoch_native_entries (
      invocation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL,
      subject TEXT NOT NULL, generation TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_epoch_completed_invocations (
      invocation_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_epoch_entry_references (
      receipt_id TEXT NOT NULL REFERENCES runtime_epoch_receipts(id), invocation_id TEXT NOT NULL,
      PRIMARY KEY(receipt_id,invocation_id));
    CREATE TRIGGER IF NOT EXISTS runtime_epoch_complete_invocation AFTER UPDATE OF state ON runtime_invocations
      WHEN NEW.state='completed' AND OLD.state='active'
      AND (EXISTS(SELECT 1 FROM runtime_epoch_execution WHERE invocation_id=NEW.id)
        OR EXISTS(SELECT 1 FROM runtime_epoch_native_entries WHERE invocation_id=NEW.id))
      BEGIN INSERT OR IGNORE INTO runtime_epoch_completed_invocations VALUES(NEW.id,NEW.generation); END;
  `);
  for (const table of ["host_contract_adoptions", "runtime_epoch_publications", "runtime_epoch_ordinary_publications", "runtime_epoch_origins", "runtime_epoch_receipts", "runtime_epoch_execution", "runtime_epoch_entry_references"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'host epoch evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'host epoch evidence is retained'); END;`);
  }
  for (const table of ["runtime_epoch_native_entries", "runtime_epoch_completed_invocations"]) db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'host epoch evidence is immutable'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS runtime_epoch_native_entries_retained_delete BEFORE DELETE ON runtime_epoch_native_entries
    WHEN EXISTS(SELECT 1 FROM runtime_epoch_entry_references WHERE invocation_id=OLD.invocation_id)
      OR NOT EXISTS(SELECT 1 FROM runtime_epoch_completed_invocations WHERE invocation_id=OLD.invocation_id)
    BEGIN SELECT RAISE(ABORT,'host epoch entry is referenced or unresolved'); END;
    CREATE TRIGGER IF NOT EXISTS runtime_epoch_completed_invocations_retained_delete BEFORE DELETE ON runtime_epoch_completed_invocations
    WHEN EXISTS(SELECT 1 FROM runtime_epoch_native_entries WHERE invocation_id=OLD.invocation_id)
      OR EXISTS(SELECT 1 FROM runtime_epoch_execution WHERE invocation_id=OLD.invocation_id)
    BEGIN SELECT RAISE(ABORT,'host epoch completion is referenced'); END;`);
}

export function hasHostEpochSchema(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_epoch_tasks'").get());
}
