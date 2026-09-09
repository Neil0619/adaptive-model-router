# Native macOS smoke test

This is the blocking logged-in macOS gate for `v0.4.0`. Run the continuity
portion in Codex Desktop on native macOS against the frozen
`codex/v040-hot-upgrade-release` ref. CLI checks remain supplementary and cannot replace
the same-Desktop-task gate.
Do not create or push the release tag from this smoke task.

<!-- smoke-contract: post-trust-agent-owned-v1 selector-optional-v1 -->

## Pass criteria

- Candidate-ref installation and current hook trust succeed.
- Global automatic activation persists across a new project/task.
- An ordinary substantive prompt, without a skill trigger phrase, produces one
  `delegate` route, one bounded subagent, root verification, and one outcome.
- The returned `delegate` is executed as the applicable skill's explicit
  authorization under conditional multi-agent policies, never weakened into a
  suggestion, blanket prohibition, user re-authorization request, or silent
  root-only continuation.
- The bounded subagent receives the isolation context, completes only its
  assigned scope, and never creates a pending root-model event or recursively
  calls `route_stage`.
- A deliberately unlaunched `delegate` is blocked by the first root Stop, names
  the required `spawn_agent` action, and creates no outcome; if the guarded Stop
  re-entry still finds the ticket unconsumed, it marks the lifecycle ambiguous
  and retains the gate until authoritative reconciliation.
- A GPT-6-only policy never delegates outside its scope; an explicit Luna
  override asks the user without starting a subagent.
- Route and execution metadata keep the root boundary unchanged while recording
  the bounded target separately. A visible selector check is optional UX only.
- Native host-model overrides are observed through trusted Hooks and task
  state. Pending and current-task manual mode prevent delegation;
  keep-automatic restores automatic state. The initial model and exposed
  reasoning effort are restored and verified even after failure.
- Status, history, diagnostics, Hook output, and SQLite contain no prompt,
  source, secret, or absolute project path.
- The auxiliary classifier initializes from the logged-in host store, keeps its
  thread ephemeral, and leaves no additional ID in `thread/list`.
- Native and wrapper upgrade/uninstall/reinstall flows are idempotent.
- One real Desktop task remains open across the compatible upgrade and, in the
  same Hook-injected context afterward, completes `route_stage → delegate →
  record_outcome` with the root model unchanged. A frozen native inventory must
  report `stdio-bridge`; a native-tool task must retain native transport.
- The Desktop shim path, ownership, and reduced-`PATH` probe are visible. A
  skipped, unresolved, unowned, or failed shim is a blocking failure whenever
  old-task continuity depends on it.
- Automated same-process v0.4 compatible-runtime activation, quarantine, and
  rollback tests pass; no absolute cache path appears in the runtime pointer.

## 1. Prepare a Unicode project and candidate checkout

```bash
CandidateRef="codex/v040-hot-upgrade-release"
SmokeRoot="$(mktemp -d)/Adaptive Router macOS 冒烟"
Source="$SmokeRoot/source checkout"
Project="$SmokeRoot/测试 project with spaces"
mkdir -p "$Project"
git clone --branch "$CandidateRef" --single-branch \
  https://github.com/Neil0619/adaptive-model-router.git "$Source"
CandidateCommit="$(git -C "$Source" rev-parse HEAD)"
PluginTreeSha256="$(git -C "$Source" ls-tree -r --full-tree "$CandidateCommit" plugins/adaptive-model-router | shasum -a 256 | awk '{print $1}')"
git -C "$Project" init
node --version
git --version
codex --version
```

Stop if Node is older than `24.15.0`, Codex is not logged in, or the candidate
ref does not resolve to the reviewed commit.

Run the complete automated gate from the exact clone before installation:

```bash
cd "$Source/plugins/adaptive-model-router"
# Required after any manifest cachebuster update.
npm run sync-runtime-version
npm test
npm run validate
npm run eval
```

## 2. Install and trust the candidate

Inspect existing state first:

```bash
codex plugin marketplace list
codex plugin list
```

Remove a same-name marketplace only when it is the known
`Neil0619/adaptive-model-router` installation. Stop on an unrelated source.
When that known installation exists, remove it first:

```bash
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

Then install the candidate:

```bash
codex plugin marketplace add Neil0619/adaptive-model-router --ref "$CandidateRef"
codex plugin add adaptive-model-router@adaptive-model-router
node "$Source/scripts/verify-installed-candidate.mjs" \
  --ref="$CandidateRef" --commit="$CandidateCommit"
```

The verifier binds Codex marketplace metadata when present, otherwise the
marketplace Git checkout, to the reviewed repository, cloned ref, and full
revision. It also requires the installed, enabled plugin to report version `0.4.0`.
Stop if it fails. Run it again after the final lifecycle reinstall in section 6.

Open `$Project` in Codex, start a new task, review `/hooks`, and trust the
current `SessionStart(source=compact)`, `SubagentStart`, `SubagentStop`,
`PreToolUse(Agent)`, `PostToolUse(Agent)`, `UserPromptSubmit`, and `Stop`
definitions. Never bypass Hook trust.

Before accepting trust, run one substantive `route_stage` probe and require
`continue` with `HOOK_TRUST_REQUIRED`, no carrier, no delegation attempt, and no
Agent. After accepting the exact current definitions, supported native builds
first issue one `HOST_LIFECYCLE_QUALIFICATION` fixed no-tool child. Require the
server's full source audit and outcome acceptance before routing the original
stage into the normal `delegate` lifecycle. Unsupported builds return
`continue / HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN` with no ticket or Agent. Trusted
inventory alone must never authorize an ordinary-work child. The disposable
`scripts/probe-native-qualification.mjs` exercises this production MCP admission
path and checks two distinct children, two outcomes, and both gate releases;
its temporary state does not qualify the current Desktop task.

After this trust step, the smoke agent owns every remaining prompt, control
message, host-managed model transition, verification, and restoration. It must
not ask the operator to retype controls or change the model selector.

The smoke agent submits `router: global on` once, then `router: status`.
Confirm global automatic activation is on, task mode is automatic, and the
first observed model only establishes a baseline without a pending question.

## 3. Run the automatic route lifecycle

Use the managed route-lifecycle contract in section 5 of the
[Windows smoke runbook](WINDOWS_SMOKE.md). The ordinary managed prompt must not
name the skill, use `$adaptive-model-router`, or contain a router control prefix.

The result must include one `delegate` route, exactly one bounded subagent using
the returned model and `reasoning_effort` through the direct native
`spawn_agent` tool outside `functions.exec`, a caller-supplied
`fork_turns: "none"` input validated without rewrite by the trusted
`PreToolUse` hook, successful root verification,
and exactly one strict `record_outcome`. Machine-verify that route and execution
metadata keep the root task unchanged and record the bounded target separately.
The native ordering probe must also accept the observed v2 sequence where a
task-name-only `PostToolUse` precedes `SubagentStart`: the attempt stays
non-ambiguous and busy until the trusted child claim supplies the agent ID, and
only the matching `SubagentStop` plus outcome may finalize it.
The subagent must execute only its assigned scope and return to
the root without calling `route_stage`, asking for a manual/automatic decision,
or creating a host-model change event.

In a separate disposable task, call `route_stage` to obtain `delegate` and then
attempt to end the turn without calling `spawn_agent`. Require the first Stop
decision to be `block`, with the route ID and the exact required action in its
reason. Require zero outcomes and the same occupied gate afterward. Allow the
continued turn to use that exact carrier, complete the child lifecycle and
record the verified outcome; require the gate to become available so the smoke
does not leave a deliberate orphan.

Treat `delegate` as the applicable skill's explicit authorization under any
conditional host policy that permits skill-requested subagents. It is required,
not a suggestion. A blanket-ban explanation, user re-authorization request, or
silent root-only continuation fails this gate unless the host subagent tool
actually rejects the declared target and the tooling-failure flow is followed.

Run `router: status` and `router: history 10`. Each route must distinguish its
root-model snapshot from its bounded target. Run `diagnose_router` with the same
host task ID and assert that all projections exclude the prompt, source, secret,
and absolute project path. The Stop hook must not create outcome-bookkeeping
feedback, fabricate an `unknown` outcome, or replace the final user-facing reply.

## 4. Exercise both host-model decisions

The persistent smoke orchestrator owns this native host-control check after
Hook trust. Record the target task's initial root model and, when exposed, its
reasoning effort. Choose a different model actually supported by the native
task/thread control surface; preserve the initial effort when the host exposes
it and require the chosen model to support it. Do not infer host capabilities
from the Router's bounded-model allowlist.

1. Wait until the target task is idle, then dispatch the next prompt to that
   same task with a Codex-native model override. Verify the changed slug through
   native task state, the trusted Hook, and Router status/history.
2. Require a matching pending model-change event. A stage attempted while
   pending must continue root-only with `HOST_MODEL_INTENT_PENDING`. Resolve
   that exact change with `keep_automatic`, then verify automatic state and
   that the pending event is cleared.
3. After the task is idle, override back to the recorded initial model. Verify
   a distinct pending change, resolve it with `manual_root`, and require a
   subsequent stage to continue with `MANUAL_ROOT_SELECTED` and no subagent.
4. In a `finally` cleanup, restore the initial root model and exposed effort
   through the same native host surface, restore automatic task mode, and
   verify the native binding, trusted Hook observation, and settled Router
   status. Run this cleanup even when an earlier check fails.

A task/thread override is a smoke-orchestrator host operation. It does not
change the GPT-6 bounded policy, authorize an out-of-scope subagent, or mean the
Router changed the root model. Router-owned calls remain within the active
policy's allowed scope; ordinary smoke work uses the shared
`model-target --purpose smoke` binding. If the host cannot perform
or verify the override, report a host-capability failure. Do not substitute
Computer Use, configuration edits, app restarts, or operator model selection.
These are acceptance instructions, not a claim that the current candidate has
already passed the live check.

Keep the plugin-directory offline regressions as supplementary coverage:

```sh
node --test test/host-model.test.mjs test/hook.test.mjs
```

They cover baseline, pending, both decisions, restoration, and delegation on
the next ordinary stage after automatic mode resumes. If only these tests ran,
label that evidence `HOST_MODEL_INTENT_OFFLINE_ONLY`; it does not satisfy the
native host-model check. Keep this check separate from the compatible-upgrade
continuity test, whose root model must remain unchanged throughout the upgrade.

## 5. Exercise scoring-evolution visibility

In the same temporary project:

1. Call `get_learning_status` and confirm database version 5 is healthy, the
   active scoring profile is versioned, and no prompt or path is returned.
2. Record the current counts of routes, outcomes, proposals, and learning
   cursors. Call `shadow_route_stage` for one risk review stage using the
   active definition. Confirm `shadow: true`, `sideEffects: false`, a GPT-6 high
   or stronger preference, and unchanged counts.
3. Confirm the completed delegated route's outcome includes a four-field
   `retryBreakdown` whose sum equals `retries`.
4. Rely on `npm test` for destructive profile re-anchor/rebase/automatic
   rollback fixtures; do not mutate the smoke project's active profile.

For step 2, send this exact prompt. This is router inspection, not a live work
stage:

```text
This is read-only router inspection, not a substantive work-product stage.
Call shadow_route_stage exactly once for a risk-sensitive review using the
active scoring definition and the same current task contextId. Do not call
route_stage before or after it, do not pass hostCapabilities, and do not create
a subagent or record an outcome. Then call get_learning_status once more.
Return only: shadow, sideEffects, preferred family/effort, active profile
identity/version, and shadow_route_stage's stateCounts before/after object.
```

Stop immediately if a live route appears, any count changes, or the Stop hook
requests an outcome for the shadow preference.

## 6. Exercise lifecycle wrappers and persistence

For the direct cold lifecycle commands below, fully exit Codex Desktop and all
other Codex CLI/plugin processes first. Run them from a fresh terminal; the
subsequent wrapper upgrade is the compatible no-re-registration path.

```bash
codex plugin marketplace upgrade adaptive-model-router
codex plugin add adaptive-model-router@adaptive-model-router
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router

cd "$Source"
./install.sh --patch-agents --ref="$CandidateRef"
./install.sh upgrade --patch-agents --verify-task-tools --ref="$CandidateRef"
./install.sh uninstall --ref="$CandidateRef"
./install.sh --ref="$CandidateRef"
./install.sh --ref="$CandidateRef"
node "$Source/scripts/verify-installed-candidate.mjs" \
  --ref="$CandidateRef" --commit="$CandidateCommit"
```

On the compatible upgrade, `--verify-task-tools` is an in-place contract-probe
request only. It must report that no disposable Codex CLI task was started;
the already-open Desktop task below is the sole continuity consumer.

Confirm the owned AGENTS marker was inserted once and removed completely while
surrounding user text remained unchanged. The final two installs must be
idempotent and leave AGENTS unpatched.

The wrapper output must distinguish cold host-surface replacement from later
compatible v0.4.x+ runtime-only updates. The compatible upgrade must not call
`plugin add` or request Desktop plugin re-registration. It must preserve the
strict stable-plugin-data vault index and restore any indexed historical cache
path pruned by host reconciliation before completing. Do not claim that every
implementation-only upgrade needs a new task. It must also report matching
`liveWorkflowContractVersion` and `stdioBridgeContractVersion` values. The
automated `runtime-hot-upgrade.test.mjs` is the blocking same-process
activation test for the implementation seam, but it does not replace the
following host-continuity gate.

With only one compatible runtime and no cross-version activation, the plugin
data's `runtime/active.json` may be absent. Read the actual runtime binding in
`diagnose_router`; see [runtime pointer diagnostics](TROUBLESHOOTING.md#runtime-pointer-is-absent).
Neither a missing nor an existing pointer proves the compatible upgrade below.
The automated tests still verify path-free serialization and rollback.

Before invoking the compatible upgrade, keep one real Codex Desktop task open
and record its task/thread identity, Hook-injected Router context, root-model
baseline, active runtime, and native-versus-frozen inventory state. Run the
upgrade without closing Desktop or reopening, forking, or replacing the task.
Then, in that exact task and context, submit an ordinary substantive stage and
require one ordered `route_stage → delegate → record_outcome` lifecycle.
Verify one bounded target, one final outcome, unchanged root model, the new
compatible runtime, and the expected native or `stdio-bridge` transport. A
shim/bridge skip, local fail-open, changed consumer identity, or missing outcome
fails this smoke. Hook JSON, MCP schemas, storage semantics, Skill identity/UI
metadata, or either workflow contract changing incompatibly requires cold
replacement and a genuinely new non-forked task.

Start Codex from a second temporary project without repeating `router: global
on`. An unchanged Hook hash must not create a routine second trust step; if it
does, investigate the installed candidate identity or trust record. Use
`router: status` to confirm the global setting persisted while task-specific
manual state did not.

## 7. Produce canonical evidence and report

Copy the checked-in fail-closed template only after completing every preceding
step:

```bash
EvidenceDir="$Source/docs/release-evidence/v0.4.0"
mkdir -p "$EvidenceDir"
cp "$Source/docs/release-evidence/templates/macos-v1.json" "$EvidenceDir/macos.json"
```

Populate `macos.json` only from observed results. Replace the timestamp,
candidate commit/tree hash, environment versions, route target/gate and final
diagnostics. Populate every `continuity` field from the same real Desktop task:
hash the raw task, context, route, and outcome-route IDs with SHA-256; record
the candidate commit, unchanged root model, advancing runtime, before/after
transport, shim status, one delegated target, one recorded passed outcome, and
`desktopStayedOpen=true`. Map the 17 checks as follows:

- preflight, frozen commit, exact-clone test/validate/eval, native install and
  both installed-revision verifications cover the first five IDs;
- Hook trust/global activation, delegate/outcome, root/target separation, Luna
  guard, privacy, learning/shadow, host-model intent and negative control cover
  the next eight IDs;
- native/wrapper lifecycle, same-task hot upgrade, second-project persistence
  and settled final status cover the final four IDs.

Change a check from `SKIP` to `PASS` only when its corresponding observation
passed. For an overall PASS, set `warnings` to `[]`, set the strict route and
healthy diagnostic fields, and change top-level `status` last. Then validate and
generate the only derived views:

```bash
node "$Source/scripts/validate-smoke-evidence.mjs" "$EvidenceDir/macos.json" \
  --write-derivatives --expected-ref="$CandidateRef" \
  --expected-commit="$CandidateCommit"
```

Retain `macos.json`, `macos.md`, and `macos.json.sha256`. The validator rejects
placeholders, incomplete checks, mismatched platform/ref/commit, pending or
Stop-finalized unknown outcomes, unhealthy diagnostics, and private path-like
data from any `PASS` artifact.

The template, schema, and validator bind the pre/post-upgrade task/thread
identity, exact Router context, root-model baseline, old/new runtime,
native-versus-bridge transport, route ID, and recorded outcome. Any missing or
mismatched binding makes `PASS` invalid.

A task whose native inventory was already frozen may legitimately use
`stdio-bridge` both before and after a later compatible upgrade. The evidence
must record that exact repeated bridge path; `unavailable` is reserved for the
one-time transition in which the task had no usable Router transport before the
compatibility bridge was installed.

Record that the current Hook definitions were reviewed and trusted before the
run. The JSON is the blocking functional source of truth. The summary below is
agent-produced; its selector field is optional, non-blocking UX information.

Return:

```text
Native macOS smoke: PASS | FAIL
macOS version:
Codex surface and version:
Node version:
Git version:
Candidate ref and commit:
Native install and Hook trust: PASS | FAIL
Global automatic persisted: PASS | FAIL
Ordinary prompt delegate lifecycle: PASS | FAIL
Observed root model:
Bounded target model/effort:
Optional selector UX observation: NOT OBSERVED | PASS | FAIL
Verification and record_outcome: PASS | FAIL
Pending keep-automatic behavior: PASS | FAIL
Manual-root behavior: PASS | FAIL
Negative control: PASS | FAIL
Learning status/database v5: PASS | FAIL
Shadow scoring had zero lifecycle side effects: PASS | FAIL
Typed retry breakdown: PASS | FAIL
Privacy assertion: PASS | FAIL
Native and wrapper lifecycle: PASS | FAIL
Compatible runtime hot-upgrade/rollback suite: PASS | FAIL
Same Desktop task compatible-upgrade lifecycle: PASS | FAIL
Continuity transport: native | stdio-bridge
Desktop shim path/ownership/reduced-PATH probe: PASS | FAIL | NOT REQUIRED
AGENTS marker cleanup: PASS | FAIL
Unexpected sanitized warnings:
```

Mark the smoke `FAIL` if any required route delegates while pending/manual, the
host cannot use the returned target, an outcome remains pending, private data
appears in a projection, or lifecycle operations are not idempotent. Do not
call `clear_project_data` or create the release tag.
