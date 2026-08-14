# macos-native smoke evidence

Status: **PASS**

Generated: 2026-08-14T07:35:42.000Z

Candidate: `codex/v040-hot-upgrade-release` at `abc85a8fa919a789f883545f5dfbc3899737816d`

Plugin tree SHA-256: `eaa84328ac025f46cdb559bbc35077a32880838f0a922796b1921a594a909125`

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

Same Desktop task/context: yes; runtime 0.4.0+codex.20260814065649 → 0.4.0+codex.20260814071304; transport native.

Database: ok; classifier: closed; privacy: PASS.
