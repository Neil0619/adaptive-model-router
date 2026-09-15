import { payloadHash } from "./io.mjs";

// Content integrity for an already source-audited recovery record. This is not
// an authorization/signature and never substitutes for the native verifier or
// its transactional state comparison. It preserves diagnostic fields too.
export function recoveryRecord(receipt) {
  const { recordDigest: _previous, ...record } = receipt;
  return { ...record, recordDigest: payloadHash(record) };
}

export function recoveryRecordIntact(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  const { recordDigest, ...record } = receipt;
  return typeof recordDigest === "string" && recordDigest === payloadHash(record);
}
