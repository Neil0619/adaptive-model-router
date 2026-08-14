# Release smoke evidence

`schema-v1.json` is the allowlisted, path-free evidence contract for native
platform smoke gates. The JSON file is the sole machine-readable source of
truth. Generate the
human-readable Markdown view and SHA-256 sidecar with:

```text
node scripts/validate-smoke-evidence.mjs <evidence.json> --write-derivatives
```

Evidence must be collected from the exact frozen candidate commit. A `PASS`
is invalid unless all 17 canonical blocking checks pass, diagnostics are
healthy, the bounded target is Sol/Terra, privacy passes, delegated/Stop
outcome counts are settled, and the same real Desktop task completes a
compatible upgrade lifecycle. Raw Codex events, prompts, source, logs,
session/context identifiers, errors, secrets, and absolute paths are forbidden.
Task, context, route, and outcome identities are stored only as SHA-256
digests; the validator requires the before/after pairs to match.

Reviewing and trusting the current Hook definitions remains the only required
human prerequisite. The canonical artifact is the blocking functional evidence
for root/target separation and host-model intent. A visible selector or status
line observation is optional, non-blocking UX evidence and is deliberately
excluded from the JSON contract.
<!-- smoke-contract: hook-trust-only-human-v1 selector-optional-v1 -->

Canonical `windows.json` and `macos.json` release evidence belongs under
`docs/release-evidence/v0.4.0/` after each native platform run. macOS collection
starts from the fail-closed `templates/macos-v1.json` and follows
`docs/MACOS_SMOKE.md`; the template itself is never PASS evidence. Do not copy
forward evidence after a plugin, wrapper, marketplace, Hook, skill, contract,
test, runbook, evidence-gate, or release-workflow change.

The persistent Codex App smoke orchestrator starts from
`templates/continuity-receipt-v1.json`, replaces every placeholder only from
the observed same-task lifecycle, and gives that redacted receipt to the
Windows runner. The receipt is an intermediate input, not release evidence by
itself.

Release automation calls the validator with `--require-pass` through
`scripts/verify-release-evidence.mjs`. That gate requires both native
artifacts, checks that their frozen ref has not moved, recomputes the plugin
tree hash, and rejects any release-relevant file change after smoke. A
schema-valid `FAIL` artifact remains useful diagnostic history but cannot
authorize a release. The checked-in
`docs/release-waivers/v0.4.0-windows-native.json` file is the byte-preserved
historical receipt for the consumed one-time v0.4.0 publication decision. The
current verifier does not read it, the release workflow does not package it,
and official tag environment variables cannot relax the requirement that both
native artifacts bind the same frozen candidate and report `PASS`.
