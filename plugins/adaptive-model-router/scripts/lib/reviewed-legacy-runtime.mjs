// Complete installed-package identities, not version labels or caller claims.
// Admission still requires real A/B writer and cold native-entry verification.
const baselines = new Map([
  ["9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2",
    Object.freeze({ pendingLimit: 10, capacityReason: "ROUTER_GLOBAL_PENDING_LIMIT" })],
  // Windows 2026-09-09: all 136 files from 4165bc15af853e2e6eb04cfbb81db96747cad8a7
  // with the original CRLF checkout bytes, including manifest and host entries.
  // This writer predates the ten-slot ledger and must retain its stricter cap.
  ["14af4672a694ed4093489ced95a5e72b13063bb000dcf343e6843bef660215eb",
    Object.freeze({ pendingLimit: 4, capacityReason: "ROUTER_CHILD_STORAGE_LIMIT" })],
]);

export function reviewedLegacyRuntime(record) {
  return record.descriptor.shellProtocolVersion === 1 ? baselines.get(record.digest) || null : null;
}
