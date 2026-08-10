# Release smoke evidence

`schema-v1.json` is the allowlisted, path-free evidence contract for native
platform smoke gates. The JSON file is the sole machine-readable source of
truth. Generate the
human-readable Markdown view and SHA-256 sidecar with:

```text
node scripts/validate-smoke-evidence.mjs <evidence.json> --write-derivatives
```

Evidence must be collected from the exact frozen candidate commit. A `PASS`
is invalid unless all 16 canonical blocking checks pass, diagnostics are
healthy, the bounded target is Sol/Terra, privacy passes, and delegated/Stop
outcome counts are settled. Windows evidence additionally uses
`zero-approval-v1`: `approvalRequests`, `sandboxEscalations`, and
`permissionFailures` must all be zero, the host profile/policy must be
`danger-full-access`/`never`, and managed turns must be `never`/`read-only`.
Raw Codex events, prompts, source, logs,
session/context identifiers, errors, secrets, and absolute paths are forbidden.

Reviewing and trusting the current Hook definitions remains the only required
human prerequisite. The canonical artifact is the blocking functional evidence
for root/target separation and host-model intent. A visible selector or status
line observation is optional, non-blocking UX evidence and is deliberately
excluded from the JSON contract.
<!-- smoke-contract: hook-trust-only-human-v1 zero-approval-v1 selector-optional-v1 -->

Canonical `windows.json` and `macos.json` release evidence belongs under
`docs/release-evidence/v0.4.0/` after each native platform run. macOS collection
starts from the fail-closed `templates/macos-v1.json` and follows
`docs/MACOS_SMOKE.md`; the template itself is never PASS evidence. Do not copy
forward evidence after a plugin, wrapper, marketplace, Hook, skill, contract,
test, runbook, evidence-gate, or release-workflow change.
