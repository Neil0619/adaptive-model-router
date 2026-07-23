# Native macOS smoke test

This is the blocking logged-in macOS gate for `v0.3.1`. Run it in Codex Desktop
or CLI on native macOS against the frozen `codex/v031-luna-delegate-fix` ref.
Do not create or push the release tag from this smoke task.

## Pass criteria

- Candidate-ref installation and current hook trust succeed.
- Global automatic activation persists across a new project/task.
- An ordinary substantive prompt, without a skill trigger phrase, produces one
  `delegate` route, one bounded subagent, root verification, and one outcome.
- A Sol/Terra-only bounded capability never returns Luna; an explicit Luna
  override asks the user without starting a subagent.
- The Codex model selector remains the root model while Subagents shows the
  bounded target.
- A changed model slug stays root-only while pending; keep-automatic resumes on
  the next stage, and current-task manual mode prevents delegation.
- Status, history, diagnostics, Hook output, and SQLite contain no prompt,
  source, secret, or absolute project path.
- Native and wrapper upgrade/uninstall/reinstall flows are idempotent.

## 1. Prepare a Unicode project and candidate checkout

```bash
CandidateRef="codex/v031-luna-delegate-fix"
SmokeRoot="$(mktemp -d)/Adaptive Router macOS 冒烟"
Source="$SmokeRoot/source checkout"
Project="$SmokeRoot/测试 project with spaces"
mkdir -p "$Project"
git clone --branch "$CandidateRef" --single-branch \
  https://github.com/Neil0619/adaptive-model-router.git "$Source"
CandidateCommit="$(git -C "$Source" rev-parse HEAD)"
git -C "$Project" init
node --version
git --version
codex --version
```

Stop if Node is older than `24.15.0`, Codex is not logged in, or the candidate
ref does not resolve to the reviewed commit.

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
```

Open `$Project` in Codex, start a new task, review `/hooks`, and trust the
current `UserPromptSubmit` and `Stop` definitions. Never bypass Hook trust.

Send `router: global on` once, then `router: status`. Confirm global automatic
activation is on, task mode is automatic, and the first observed model only
establishes a baseline without a pending question.

## 3. Run the automatic route lifecycle

Use the exact ordinary implementation prompt in section 5 of the
[Windows smoke runbook](WINDOWS_SMOKE.md).
It intentionally does not name the skill or use `$adaptive-model-router`.

The result must include one `delegate` route, exactly one bounded subagent using
the returned model and `reasoning_effort`, successful root verification, and
exactly one strict `record_outcome`. Confirm the Codex model selector still
shows the root task during delegation; inspect the Subagents view for the
bounded target.

Run `router: status` and `router: history 10`. Each route must distinguish its
root-model snapshot from its bounded target. Run `diagnose_router` with the same
host task ID and assert that all projections exclude the prompt, source, secret,
and absolute project path. The Stop hook must report no missing outcome.

## 4. Exercise both host-model decisions

Follow section 6 of the [Windows smoke runbook](WINDOWS_SMOKE.md) on macOS:

1. Change to a different model slug, not only a different effort.
2. Submit the ordinary review prompt and confirm `continue` with
   `HOST_MODEL_INTENT_PENDING`, no subagent, and one stable change ID across an
   unanswered reminder.
3. Send `router: auto session`; confirm automatic mode resumes from the next
   substantive stage.
4. Change the slug again, create a new pending event, send `router: manual`, and
   confirm a substantive `route_stage` returns `continue` with
   `MANUAL_ROOT_SELECTED` and no target.
5. Restore with `router: auto session`.

Record that effort-only changes are not visible to the Hook and require an
explicit `router: manual` when they mean root-only intent.

Also run the negative control in section 7 of the
[Windows smoke runbook](WINDOWS_SMOKE.md).

## 5. Exercise lifecycle wrappers and persistence

Exit the task and run:

```bash
codex plugin marketplace upgrade adaptive-model-router
codex plugin add adaptive-model-router@adaptive-model-router
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router

cd "$Source"
./install.sh --patch-agents --ref="$CandidateRef"
./install.sh upgrade --patch-agents --ref="$CandidateRef"
./install.sh uninstall --ref="$CandidateRef"
./install.sh --ref="$CandidateRef"
./install.sh --ref="$CandidateRef"
```

Confirm the owned AGENTS marker was inserted once and removed completely while
surrounding user text remained unchanged. The final two installs must be
idempotent and leave AGENTS unpatched.

Start Codex from a second temporary project without repeating `router: global
on`. Trust the current Hook hash if asked, then use `router: status` to confirm
the global setting persisted while task-specific manual state did not.

## 6. Report

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
Codex selector stayed on root: PASS | FAIL
Verification and record_outcome: PASS | FAIL
Pending keep-automatic behavior: PASS | FAIL
Manual-root behavior: PASS | FAIL
Negative control: PASS | FAIL
Privacy assertion: PASS | FAIL
Native and wrapper lifecycle: PASS | FAIL
AGENTS marker cleanup: PASS | FAIL
Unexpected sanitized warnings:
```

Mark the smoke `FAIL` if any required route delegates while pending/manual, the
host cannot use the returned target, an outcome remains pending, private data
appears in a projection, or lifecycle operations are not idempotent. Do not
call `clear_project_data` or create the release tag.
