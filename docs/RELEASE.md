# v0.4.0 release checklist

This file is the maintainer release gate. The detailed native Windows procedure
lives in [WINDOWS_SMOKE.md](WINDOWS_SMOKE.md). Do not create the release tag
until every blocking item below has fresh evidence for the exact candidate
commit.

v0.4.0 is stacked on the v0.3.1 capability fix. Do not freeze or release this
candidate until v0.3.1 has been reviewed and merged, and the v0.4.0 branch has
been rebased or recreated on that final main tree without changing its
reviewed runtime content.

## 1. Freeze the candidate

Keep `stable` on the last published release until the release workflow has
created the new artifacts. For logged-in smoke testing, freeze a dedicated
candidate ref at the reviewed commit. For v0.4.0 the handoff ref is
`codex/v040-scoring-evolution`; do not move it after smoke evidence is
collected.

Record the candidate:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git rev-parse origin/codex/v040-scoring-evolution
git rev-parse origin/stable
```

The worktree must be clean. The candidate ref must contain the reviewed tree;
`stable` may still point to v0.3.1. Before tagging a later `main` merge commit,
verify that the release-relevant trees are byte-identical:

```bash
git diff --exit-code origin/main origin/codex/v040-scoring-evolution -- \
  .agents plugins install.sh install.ps1 .github/workflows/release.yml
```

Any installed plugin, marketplace, wrapper, hook, skill, contract, test, or
release-workflow
change after this point creates a new runtime candidate and invalidates earlier
manual smoke evidence.

A documentation-only follow-up still creates a new release commit. Earlier
runtime smoke evidence may be reused only when the maintainer records that the
plugin tree, marketplace file, `install.sh`, `install.ps1`, and release workflow
are byte-identical between the smoked and final commits. Otherwise rerun the
smoke gate.

## 2. Automated gate

- Ubuntu, macOS, and Windows pass on Node 24.15.0 and the latest Node 24 LTS.
- Unit, 50-process concurrency, privacy, hook, MCP, installer, and the 226-case
  bilingual-route plus score-band evaluation suites pass.
- Syntax, manifest, marketplace, plugin, and skill validation pass.
- CodeQL passes.
- `private: true` remains present; no npm package is published.

Local preflight:

```bash
cd plugins/adaptive-model-router
npm test
npm run validate
npm run eval
```

## 3. Logged-in smoke gate

Run the complete route lifecycle once on macOS and once on native Windows 11:

1. Install from the frozen candidate ref with the two native Codex commands;
   published `stable` remains on v0.3.1 until all smoke evidence passes.
2. Review and trust the plugin's `UserPromptSubmit` and `Stop` handlers.
3. Send `router: global on` once, restart into a new project/task, and confirm
   the setting persists without repeating the command.
4. Submit an ordinary substantive task that does not name the skill or include
   a trigger phrase, and obtain a `delegate` route.
5. Create exactly one bounded subagent using the returned model and effort;
   confirm the Codex selector continues to display the root task.
   Confirm the route input uses the host's bounded-subagent capability rather
   than the root picker. A Sol/Terra-only host must not return Luna.
6. Integrate the result, run the returned verification gate, and record one
   strict `passed` or `failed` outcome.
7. Confirm status and route history preserve the root-model versus
   bounded-target boundary, include the delegated route/outcome, and expose no
   prompt, source, secret, or absolute project path.
8. Change the active model slug after its baseline. Confirm the pending request
   and unconfirmed reminders stay root-only, then test both keep-automatic and
   current-task manual-root decisions. Record that effort-only changes are not
   observable by the hook.
9. Exercise upgrade, uninstall, reinstall, idempotence, and optional AGENTS
   marker removal.
10. Confirm database v3 learning status, a versioned scoring profile, typed
    retry breakdown, and shadow scoring with no route/outcome/proposal/cursor
    changes.

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
