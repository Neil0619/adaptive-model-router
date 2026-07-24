# Changelog

All notable changes to this project are documented here.

## [0.4.0] - Unreleased

### Added

- SQLite `user_version` 3 with immutable, versioned scoring profiles and one
  redacted score snapshot per delegated route. Snapshots contain only numeric
  scores, boolean signals, enum decisions, profile IDs, and learning
  eligibility reasons.
- Strict per-failure `retryBreakdown` outcomes so reasoning retries can be
  learned independently from environment, information, and tooling failures.
- Conservative online category-offset evidence: explicit overrides,
  classifier-adjusted routes, escalations, unknown outcomes, and non-reasoning
  failures are quarantined; proposals also require evidence across distinct
  task contexts.
- `get_learning_status`, `shadow_route_stage`,
  `reanchor_scoring_profile`, and `rebase_policy_proposal` tools.
- Offline scoring-profile re-anchoring with explicit confirmation, immutable
  parent links, stale-proposal handling, and preserved approved category
  offsets.
- A hard safety invariant that automatically rolls an active offline profile
  back to its parent if a snapshotted risk/security/migration route violates
  the Sol-high floor.
- A 226-case deterministic evaluation gate: 24 bilingual end-to-end routes and
  202 score-band/hard-signal cases.
- A stable v0.4 launch shell and strict `runtime.json` descriptor. Existing
  v0.4 tasks can activate compatible implementation updates on the next Hook
  or MCP call, with isolated contract/health probes, an atomic active/previous
  pointer, concurrent activation safety, and automatic quarantine/rollback.
- Forward-compatible storage-contract checks that allow an older v0.4 runtime
  to reopen a newer additive SQLite schema while rejecting incompatible
  future schemas.

### Changed

- Shadow scoring has no route, outcome, proposal, or cursor side effects.
- Proposal status now reports distinct-context, failure, correction, and
  reasoning-retry counts. Rebase keeps the proposal delta while advancing the
  old evidence cursor.
- The v0.3.x → v0.4.0 transition requires one fresh task; later compatible
  runtime-only updates do not. Hook, skill, MCP-schema, and storage-contract
  changes remain explicit restart boundaries.

## [0.3.1] - Unreleased

### Fixed

- Re-anchored deterministic routing to keep low-complexity, non-batch stages in
  the root; use Terra for routine bounded work; and reserve stronger Sol effort
  for review, risk, architecture, and failure-cost signals.
- Corrected the effort strength order to
  `high < xhigh < max < ultra`. Static routing can select Max only at score
  `98..100` with at least two independent hard signals and never selects Ultra;
  Ultra is reachable only through reasoning-failure escalation or an explicit
  override.
- Counted correlated security and migration evidence as one hard-signal
  dimension for the Max gate. Added explicit public-contract, architecture
  trade-off, irreversibility, and high-failure-cost evidence fields.
- Kept environment, information, and tooling failures from increasing effort,
  and made the two-step reasoning escalation chains monotonic through Max and
  Ultra before asking the user.
- Refused Ultra delegation when the caller reports parallel-write risk.
- Separated root-visible, bounded-delegation, and auxiliary-classifier model
  catalogs so a root-only Luna model is never returned as a subagent target.
- Added strict optional `hostCapabilities.delegation` input. Current host
  models and effort enums are authoritative; older callers conservatively use
  Sol and Terra only.
- Automatic Luna preferences now fall back to Terra with
  `MODEL_FAMILY_FALLBACK`; explicit unavailable Luna overrides ask the user and
  do not consume a once override.
- A host tooling rejection records a failed outcome and permits at most one
  automatic retry with the rejected target excluded. Explicit failures never
  silently substitute, and a second automatic rejection fails open to root.
- The auxiliary classifier now discovers its own models from app-server
  `model/list`, independently of bounded subagent capability.

## [0.3.0] - 2026-07-21

### Added

- One-time global automatic-routing opt-in for substantive tasks, with no
  required `$adaptive-model-router` trigger phrase.
- Hook-observed root-model baselines and task-scoped model-intent protection:
  pending changes stay root-only until the user chooses manual-root or keeps
  automatic routing.
- Strict `resolve_host_model_intent` MCP confirmation with context binding,
  idempotent repeats, and rejection of conflicts or stale change IDs.
- SQLite `user_version` 2 migration for task modes, host-model change events,
  and per-route root-model snapshots while preserving v0.2 learning state.
- Route schema 3.0 fields for root-task visibility and automatic, pending, or
  manual task mode.
- Visible post-route notices that distinguish the unchanged host-managed root
  model from a bounded-stage model/effort target.
- Read-only `get_route_history`, `router: history`, `路由器：历史`, and developer
  CLI history views with timestamps, target transitions, reason codes, and
  outcomes.
- Expanded status reports with current-stage state, route time, reasons,
  transition, and outcome.
- English and Chinese documentation for the exact trigger path and
  deterministic scoring thresholds.

### Changed

- Installed launchers recover the plugin data root when Windows MCP startup
  omits `PLUGIN_DATA`, and MCP calls resolve the project most recently observed
  by the trusted hook instead of relying on a stale server working directory.
- Session disable controls remain automatic-mode overrides so explicit routes
  report `ROUTER_DISABLED` instead of being mislabeled as manual-root work.
- `UserPromptSubmit` injects minimized model-visible routing context for
  ordinary tasks only after explicit global opt-in; it never copies prompt,
  path, or source content.
- Status and history separately display an observed root model and the bounded
  stage target. The Codex model selector remains owned by the root task.
- Missing or invalid hook model values remain host-managed and never imply
  manual intent. Root reasoning effort remains host-only and cannot be inferred.

## [0.2.0] - 2026-07-19

### Added

- Standard Codex plugin and repo marketplace manifests.
- Bounded `delegate`, `continue`, and `ask_user` route actions.
- Project/context-isolated SQLite state with transactional once overrides and outcomes.
- Approval-gated immutable learning policies, rejection, and monotonic rollback.
- Redacted eight-second auxiliary classifier with a persistent circuit breaker.
- Strict MCP tools for routing, outcomes, configuration, diagnostics, project deletion, and policy management.
- Exact-prefix control and two-pass Stop hooks with native Windows commands.
- Cross-platform runtime discovery for Codex hosts whose `node` differs from the interactive shell.
- Idempotent POSIX and PowerShell installation wrappers with opt-in AGENTS patching.
- Ubuntu, macOS, Windows, CodeQL, release artifact, and bilingual routing-evaluation workflows.
- Maintainer-ready native Windows 11 smoke, public tool-reference,
  troubleshooting, and documentation-index runbooks.

### Changed

- Minimum runtime is Node.js 24.15.0.
- Plugin state uses Codex's writable `PLUGIN_DATA`, and upgrades validate the configured ref from Codex marketplace metadata or its checked-out Git branch.
- The product is explicitly a bounded-subagent router and does not claim root-model hot switching.
- Legacy JSON learning history is not imported into v0.2 evidence windows.

### Removed

- Unsupported `agentType`/`agent_type` routing output.
- JSON read-modify-write state and automatic once-override consumption before delegation.
- Free-text classifier reasons and permissive outcome parsing.
