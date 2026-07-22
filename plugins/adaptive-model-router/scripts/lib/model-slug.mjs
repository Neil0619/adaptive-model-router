const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_PATTERN = /^(?:sk-[A-Za-z0-9_-]{10,}|gh[opurs]_[A-Za-z0-9_]{10,}|AKIA[A-Z0-9]{12,})$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:\//;
const URI_PATH_PATTERN = /^(?:file|https?|ssh):\/+/i;
const RELATIVE_PATH_SEGMENT_PATTERN = /(?:^|\/)\.{1,2}(?:\/|$)/;

export function normalizeModelSlug(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!MODEL_SLUG_PATTERN.test(normalized)) return null;
  if (SECRET_PATTERN.test(normalized)) return null;
  if (WINDOWS_ABSOLUTE_PATTERN.test(normalized)) return null;
  if (URI_PATH_PATTERN.test(normalized)) return null;
  if (RELATIVE_PATH_SEGMENT_PATTERN.test(normalized)) return null;
  return normalized;
}
