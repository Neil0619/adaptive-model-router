import { sanitizedError } from "./io.mjs";
// Closed, non-sensitive classifications. Never persist an exception's message,
// stack, input, or arbitrary code as an observation.
const DEFINITIONS = {
  INVALID_INPUT: ["input_validation", "Use the advertised input schema; unknown fields are rejected."],
  RETRY_PREDECESSOR_REQUIRED: ["retry_contract", "For a retry of the same failed stage, record its failed outcome and supply previousRouteId, the same stageId, and failureType. For an independent new issue, start a new stage without verificationFailed."],
  RETRY_FAILURE_TYPE_REQUIRED: ["retry_contract", "A same-stage retry requires the failureType from its matching failed outcome."],
  RETRY_STAGE_MISMATCH: ["retry_contract", "Retry the predecessor with its original stageId. An independent new issue uses a new stage without previousRouteId or verificationFailed."],
  RETRY_OUTCOME_REQUIRED: ["retry_contract", "First verify and record the matching failed outcome. A rejected request or busy response is not a failed outcome."],
  RETRY_PREDECESSOR_INVALID: ["retry_contract", "Use the latest retryable attempt belonging to this task and stage; do not reuse another stage's route."],
  OUTCOME_BEFORE_DISPATCH: ["lifecycle_precondition", "The matching native dispatch handshake must be verified first."],
  OUTCOME_CONFLICT: ["lifecycle_precondition", "A final outcome is immutable; inspect the existing record."],
  OUTCOME_GATE_MISMATCH: ["input_validation", "Use the verification gate returned by the delegated route."],
  CALLER_BINDING_UNPROVEN: ["caller_binding", "Use the actual native task identity and its matching trusted Hook receipt."],
  RUNTIME_COMPATIBILITY: ["runtime_compatibility", "Inspect the retained runtime and source-owned handover evidence."],
  VERIFICATION_EVIDENCE_UNSUPPORTED: ["runtime_compatibility", "Keep the old outcome contract for this retained stage. Do not silently drop the attachment or claim it was recorded; current-runtime stages support the new evidence field."],
  HOOK_REJECTED: ["lifecycle_precondition", "Inspect this task's trusted lifecycle and pending stage responsibilities."],
  HOOK_UNCORRELATED: ["caller_binding", "The native result did not match a trusted pending operation."],
  HOOK_IDENTITY_MISSING: ["caller_binding", "Trusted native task or child identity was unavailable."],
  STAGE_PRECONDITION: ["lifecycle_precondition", "Inspect stageClosure and the latest revision; supply only the existing trusted child identity and preserve unfinished work."],
  TRANSPORT_FAILURE: ["transport", "Inspect bridge or launcher transport health before retrying the operation."],
  STORAGE_BUSY: ["storage_busy", "The local state store is busy; retain the pending work and retry later."],
  STORAGE_UNAVAILABLE: ["storage_io", "Inspect local state storage access and integrity."],
  INTERNAL_ERROR: ["internal", "An unexpected internal error occurred; inspect the correlated diagnostic event."],
};

export function requestError(code, message) {
  if (!Object.hasOwn(DEFINITIONS, code)) throw new TypeError("Unknown request error code");
  return Object.assign(new Error(`${message} ${DEFINITIONS[code][1]}`), { code });
}

export function isStorageFailure(error) {
  // Node's SQLite errors use ERR_SQLITE_ERROR plus a numeric primary/extended
  // SQLite result code. Generic exceptions, constraint errors and SQL defects
  // must never masquerade as an unavailable store.
  const sqlite = Number(error?.errcode) & 255;
  return [5, 6, 8, 10, 11, 13, 14, 26].includes(sqlite)
    || ["SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_BUSY", "SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_NOTADB", "EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR"].includes(error?.code);
}

export function errorObservation(error) {
  let code = Object.hasOwn(DEFINITIONS, error?.code || "") ? error.code : null;
  if (!code && isStorageFailure(error)) code = [5, 6].includes(Number(error.errcode) & 255)
    || ["SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_BUSY"].includes(error.code) ? "STORAGE_BUSY" : "STORAGE_UNAVAILABLE";
  code ||= "INTERNAL_ERROR";
  return { errorCode: code, errorCategory: DEFINITIONS[code][0] };
}

export function publicRequestError(error) {
  const { errorCode: code } = errorObservation(error);
  const hint = DEFINITIONS[code][1];
  const message = code === "INTERNAL_ERROR" ? "Router internal operation failed."
    : sanitizedError({ message: String(error?.message || code).replace(hint, "").trim() });
  return JSON.stringify({ code, message, hint });
}
