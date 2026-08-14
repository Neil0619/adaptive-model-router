# macos-native smoke evidence

Status: **PASS**

Generated: 2026-08-14T10:36:56Z

Candidate: `codex/v040-hot-upgrade-release` at `d72ab717b5a7145c34989052d7b02972479a226d`

Plugin tree SHA-256: `0625efe2565e8f4cc1e1dffc03b20d131185a8eb0e620074051f98ea7b76d961`

| Check | Blocking | Status |
|---|---:|---:|
| native-preflight | yes | PASS |
| candidate-frozen | yes | PASS |
| candidate-automated-gate | yes | PASS |
| native-install | yes | PASS |
| installed-candidate-integrity | yes | PASS |
| hook-trust-and-global-on | yes | PASS |
| route-subagent-outcome | yes | PASS |
| root-target-boundary | yes | PASS |
| capability-boundary | yes | PASS |
| redacted-observability | yes | PASS |
| learning-and-shadow | yes | PASS |
| host-model-intent | yes | PASS |
| negative-control | yes | PASS |
| native-and-wrapper-lifecycle | yes | PASS |
| same-task-hot-upgrade | yes | PASS |
| cross-project-persistence | yes | PASS |
| final-state-settled | yes | PASS |

Route: delegate; target sol/high; gate full-checks.

Pending outcomes: 0; Stop-auto-finalized unknown: 0.

Same Desktop task/context: yes; runtime 0.4.0+codex.20260814095433 → 0.4.0+codex.20260814181412; transport stdio-bridge.

Database: ok; classifier: closed; privacy: PASS.
