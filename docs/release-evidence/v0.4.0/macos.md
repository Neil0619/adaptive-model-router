# macos-native smoke evidence

Status: **PASS**

Generated: 2026-08-14T11:29:58Z

Candidate: `codex/v040-hot-upgrade-release` at `f8ace644d90f60992093d391625d094c424c65d1`

Plugin tree SHA-256: `4f5fbde8b911629a83f94363a795c4fa598344f583c0c81c50d5e53b16ac80ef`

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

Same Desktop task/context: yes; runtime 0.4.0+codex.20260814181412 → 0.4.0+codex.20260814185904; transport native.

Database: ok; classifier: closed; privacy: PASS.
