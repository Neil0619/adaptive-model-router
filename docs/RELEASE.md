# v0.4.0 release checklist

This file is the maintainer release gate. The detailed native Windows procedure
lives in [WINDOWS_SMOKE.md](WINDOWS_SMOKE.md). Do not create the release tag
until every blocking item below has fresh evidence for the exact candidate
commit. The original `codex/v040-scoring-evolution` candidate was invalidated
by the read-only-inspection Hook fix. The later shadow-inspection candidate was
invalidated by the Stop-hook fix, and the Stop-hook candidate was invalidated
by the delegate-authorization contract fix. The replacement candidate below
includes the same reviewed v0.4 runtime plus all three fixes, Windows
cache-replacement integrity checks, explicit Stop-finalization observability,
and the canonical redacted smoke-evidence gate.

v0.4.0 includes the reviewed v0.3.1 capability fix, which was merged into the
v0.4.0 main tree and was not published separately. The published `stable`
branch therefore remains on v0.3.0 until the v0.4.0 release workflow advances
it after artifact creation.

## 1. Freeze the candidate

Keep `stable` on the last published release until the release workflow has
created the new artifacts. For logged-in smoke testing, freeze a dedicated
candidate ref at the reviewed commit. For the final v0.4.0 hot-upgrade repair
the handoff ref is `codex/v040-hot-upgrade-release`; do not move it after smoke evidence is
collected.

Record the candidate:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git rev-parse origin/codex/v040-hot-upgrade-release
git rev-parse origin/stable
```

The worktree must be clean. The candidate ref must contain the reviewed tree;
`stable` may still point to v0.3.0. Before tagging a later `main` merge commit,
verify that the release-relevant trees are byte-identical:

```bash
git diff --exit-code origin/main origin/codex/v040-hot-upgrade-release -- \
  .agents plugins scripts docs/release-evidence/schema-v1.json \
  docs/release-evidence/templates/macos-v1.json \
  docs/release-evidence/templates/continuity-receipt-v1.json \
  docs/WINDOWS_SMOKE.md docs/MACOS_SMOKE.md docs/RELEASE.md \
  install.sh install.ps1 .github/workflows/release.yml
```

Any installed plugin, marketplace, wrapper, hook, skill, contract, test, or
release-workflow
change after this point creates a new runtime candidate and invalidates earlier
native smoke evidence.

A documentation-only follow-up still creates a new release commit. Earlier
runtime smoke evidence may be reused only when the maintainer records that the
plugin tree, marketplace file, smoke runner/validator/schema/template, `install.sh`,
`install.ps1`, both native smoke runbooks, this release checklist, and release
workflow are byte-identical between the smoked and final commits. Otherwise
rerun the smoke gate.

## 2. Automated gate

- Ubuntu, macOS, and Windows pass on Node 24.15.0 and the latest Node 24 LTS.
- Unit, 50-process concurrency, privacy, hook, MCP, installer, and the 226-case
  bilingual-route plus score-band evaluation suites pass.
- The hot-runtime suite keeps one MCP process alive across a compatible
  upgrade, activates the same candidate from old Hook shells under concurrency,
  rejects a damaged candidate, rolls a later-failing active Hook back, and
  asserts that the pointer contains no absolute path.
- Compatibility tests reject mismatched `liveWorkflowContractVersion` or
  `stdioBridgeContractVersion`, require first-use bridge state to converge on the
  stable installed plugin data directory, and require the Desktop shim to be
  observable and fail closed when its path, ownership, or reduced-`PATH` probe
  cannot be established.
- Syntax, manifest, marketplace, plugin, and skill validation pass.
- The native Windows runner repeats test/validate/eval against the exact cloned
  candidate and rejects installed marketplace metadata or Git checkout identity
  whose repository, ref, or revision differs from that clone before or after
  lifecycle testing.
- CodeQL passes.
- `private: true` remains present; no npm package is published.

Local preflight:

```bash
cd plugins/adaptive-model-router
npm test
npm run validate
npm run eval
```

On native Windows, run the canonical orchestrator only after trusting the
current candidate's four hooks in a dedicated, disposable Codex Home. The
runner refuses the operator's default Codex Home:

```powershell
$SmokeCodexHome = 'D:\codex-smoke-home'
New-Item -ItemType Directory -Force -Path $SmokeCodexHome | Out-Null
Set-Content -LiteralPath (Join-Path $SmokeCodexHome '.adaptive-router-smoke-home') -Value 'adaptive-model-router smoke home v1' -NoNewline
$env:CODEX_HOME = $SmokeCodexHome
$env:ADAPTIVE_ROUTER_SMOKE_CODEX_HOME = $SmokeCodexHome
$ContinuityReceipt = Join-Path $SmokeCodexHome 'redacted-continuity-receipt.json'
.\scripts\windows-smoke.ps1 `
  -CandidateRef 'codex/v040-hot-upgrade-release' `
  -ContinuityReceiptPath $ContinuityReceipt
```

After Hook trust, the runner requires no operator-entered prompts, control
messages, model-selector actions, or status-line configuration. It performs
and restores the full functional lifecycle inside its disposable session.

Validate and retain `docs/release-evidence/v0.4.0/windows.json`, its generated
Markdown view, and its `.sha256` sidecar. The JSON must match schema v1, the
frozen ref and commit, contain no raw operational data, and report `PASS` only
when all 17 blocking checks pass, privacy passes, pending outcomes are zero,
and the hashed same-Desktop-task continuity bindings match.
Record that the current Hook definitions were reviewed and trusted before the
run. The validated Windows artifact is the blocking functional source of truth;
visible selector/status-line observations are optional, non-blocking UX notes.
<!-- smoke-contract: windows-artifact-authoritative-v1 selector-optional-v1 -->

On native macOS, retain `docs/release-evidence/v0.4.0/macos.json`, its generated
Markdown view and `.sha256` sidecar. It must be produced from the fail-closed
template and validated with both `--expected-ref` and `--expected-commit` as
specified by `MACOS_SMOKE.md`. Record the required Hook trust prerequisite;
selector/status-line observations remain optional and non-blocking.

The release workflow runs `scripts/verify-release-evidence.mjs` with
`--require-pass` semantics for both native artifacts. It rejects a moved
candidate ref, a mismatched plugin-tree hash, a valid `FAIL` artifact, or any
release-relevant tree change after evidence collection.

### Historical v0.4.0 native Windows exception

The maintainer authorized the original `v0.4.0` publication without rerunning
the native Windows same-Desktop-task continuity gate. That consumed one-time
decision did not turn the retained Windows `FAIL` artifact into a passing
result. It was limited to the official `v0.4.0` tag workflow and bound the
frozen candidate, retained evidence hash, maintainer authorization, and three
explicitly accepted Windows risks.

The byte-preserved receipt remains at
`docs/release-waivers/v0.4.0-windows-native.json` as historical evidence only.
It is not an input or asset of the current release workflow and must not be
renamed, generalized, or reused. `scripts/verify-release-evidence.mjs` no
longer exposes a waiver option: every current invocation, including an official
`v0.4.0` tag environment, requires both native artifacts to bind the same
frozen candidate and validate as `PASS`. A schema-valid retained `FAIL` remains
diagnostic history and cannot authorize another release.

## 3. Logged-in smoke gate

Run the complete route lifecycle once on macOS and once on native Windows 11.
For each platform, the blocking continuity consumer is one real Desktop task
that remains open across the compatible upgrade; a disposable CLI task or a
new Desktop task cannot substitute for it:

1. Install from the frozen candidate ref with the two native Codex commands;
   published `stable` remains on v0.3.0 until all smoke evidence passes.
2. Review and trust the plugin's `SessionStart(source=compact)`,
   `SubagentStart`, `UserPromptSubmit`, and `Stop` handlers.
3. Send `router: global on` once, restart into a new project/task, and confirm
   the setting persists without repeating the command.
4. Submit an ordinary substantive task that does not name the skill or include
   a trigger phrase, and obtain a `delegate` route.
5. Create exactly one bounded subagent using the returned model and effort;
   machine-verify that route and execution metadata keep the root boundary
   unchanged and record the bounded target separately.
   Confirm the route input uses the host's bounded-subagent capability rather
   than the root picker. A Sol/Terra-only host must not return Luna.
6. Integrate the result, run the returned verification gate, and record one
   strict `passed` or `failed` outcome.
7. Confirm status and route history preserve the root-model versus
   bounded-target boundary, include the delegated route/outcome, and expose no
   prompt, source, secret, or absolute project path.
8. Use host-managed resumed CLI turns to change the active model slug after its
   baseline. Automatically confirm that pending requests and reminders stay
   root-only, test keep-automatic and current-task manual-root decisions, and
   restore the initial model and automatic mode. Record that effort-only changes
   are not observable by the Hook.
9. Exercise upgrade, uninstall, reinstall, idempotence, and optional AGENTS
   marker removal. Confirm the installer keeps compatible v0.4+ runtime staging
   separate from cold host replacement, never uses `plugin add` for the hot
   path, archives compatible historical shells before marketplace refresh,
   reloads the post-refresh registration, restores any indexed cache paths the
   host pruned, restores them before returning any post-prune refresh failure,
   serializes concurrent installers with a crash-releasing plugin-data
   transaction, and explains the genuinely-new-non-forked-task boundary. Before the
   compatible upgrade, retain the Desktop process, task/thread ID, exact Router
   context, root-model baseline, and whether its native inventory is present or
   frozen. Do not close, reopen, fork, or replace that task during the upgrade.
10. In that same real Desktop task and context after the compatible upgrade,
    submit an ordinary substantive stage and require the ordered lifecycle
    `route_stage → delegate → record_outcome`. Verify exactly one bounded
    target and outcome, unchanged root model, advanced compatible runtime, and
    the expected native or `stdio-bridge` transport. Any shim/bridge skip,
    fallback-local result, or consumer-identity change is a blocking failure.
11. Confirm database v3 learning status, a versioned scoring profile, typed
    retry breakdown, and shadow scoring with no route/outcome/proposal/cursor
    changes.

The compatibility classification used by the gate is:

| Operation | Existing native-tool task | Existing frozen-inventory task |
| --- | --- | --- |
| Compatible hot upgrade | Same task, native transport | Same task, approved stdio bridge |
| Cold replacement or incompatible fixed/workflow contract | New non-forked task after review | New non-forked task after review |

Use [WINDOWS_SMOKE.md](WINDOWS_SMOKE.md) and
[MACOS_SMOKE.md](MACOS_SMOKE.md) for the platform-specific evidence and report
templates. WSL2 remains a separate manual or nightly smoke and does not block
an ordinary pull request.

## 4. Authentication, signing, and branch protection

Verify the intended GitHub identity before remote operations:

```bash
gh auth status -h github.com
gh repo view Neil0619/adaptive-model-router
```

If authentication is invalid or the active account is wrong, authenticate or
switch accounts before continuing:

```bash
gh auth login
```

Verify repository-local tag signing configuration and create a signed annotated
tag at the frozen candidate:

```bash
git config --local --get gpg.format
git config --local --get user.signingkey
git config --local --get tag.gpgSign
git tag --sign --message "Adaptive Model Router v0.4.0" v0.4.0
git cat-file tag v0.4.0
```

The tag object must contain an SSH signature and point to the recorded candidate
commit. Do not push an unsigned or lightweight tag.

Before pushing, confirm that `main` and `stable` reject force pushes and
deletion. The `stable` protection must still allow the release workflow to make
a normal fast-forward update after artifacts exist.

## 5. Publish and verify

Push only the signed tag:

```bash
git push origin v0.4.0
```

The release workflow must:

1. rerun tests, validation, and evaluation;
2. create the source archive and SPDX SBOM;
3. create SHA-256 checksums and build provenance;
4. publish the GitHub Release from the existing remote tag;
5. advance protected `stable` only after artifacts exist.

Verify the workflow, release assets, attestations, checksums, GitHub's signed-tag
verification result, and final `stable` commit. If the workflow fails before release creation, fix
the cause and create a new candidate/tag as appropriate. If it fails after
release creation but before `stable` advances, do not hide the partial state;
repair the protected-branch permission or workflow and document the recovery.

Do not publish the npm package. `private: true` is a release invariant.
