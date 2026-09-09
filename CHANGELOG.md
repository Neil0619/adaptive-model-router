# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Changed

- Route bounded work through GPT-6 only, with all six efforts available and
  high as the default. Explicit task conditions select stable work levels;
  diagnostic score bands and legacy learning offsets no longer select models.
- Separate allowed model scope, task conditions, and target bindings in a
  versioned policy with read-only preview, atomic activation, rollback, and
  active-call protection. Adding candidates does not add scoring intervals.
- Keep reasoning escalation within one logical stage and at most two automatic
  enhancements. Environment, information, and tooling failures retain the
  current target; explicit unavailable or out-of-scope targets fail visibly.
- Apply the same model scope to routing, locks, optional classification, and
  logged-in probes. Preserve legacy records and collect new outcomes without
  applying legacy offsets. GPT-6-only smoke covers root slug changes offline.
- Keep route identifiers in status/history and diagnostics while routine
  notices show the stage, target, effort, and only directly observed service
  tier information.

### Fixed

- Retain unknown legacy code-mode execution until exact native or root evidence
  verifies it; prospective command coverage never retroactively clears old work.
  Late poll receipts remain bound to the original command and cannot close or
  reopen a different operation that reuses its process handle.
- Keep operation inspection read-only, preserve transferred responsibility
  across maintenance cycles, and reject fresh admission while maintenance is
  active. Exact native Pre refusals remain rejected messages owned by their
  sender, with a preserving database v10 migration.
- Correlate the native memory-citation representation with Stop using the same
  child, turn, message, metadata and completed text. Preserve the full result
  digest and reject mismatched content instead of repeatedly requesting finals.
- Track same-stage followups and native command lifecycles through the latest
  result before recording one outcome. Ordinary code-mode formatting, parallel
  commands and intercepted patches no longer hide unfinished execution.
- Reconcile exceptional operations against exact native evidence and current
  message/operation snapshots. Preserve unresolved ownership, prior outcomes
  and every disposition across repeated bounded maintenance cycles.
- Base default child storage admission on actual free disk after reservations,
  retaining the global pending cap and free-space floor. Accumulated audit
  history no longer permanently prevents future delegation at 1 GiB.
- Recover ordinary Desktop `0.153.4` agent-count refusals after ticket consumption
  using exact native dispatch/error evidence and bounded streaming parent audits.
  Failed/tooling outcome calls automatically reconcile this case; the installed
  recovery CLI also handles existing stuck attempts without rewriting outcomes
  or inventing missing lifecycle Hooks. Retain the historical refusal, recheck
  current tree responsibility and permit bounded recovery with a new ticket;
  temporary full capacity does not permanently disable later delegation.
- Include all five required host parameters in automatic delegation guidance.
  A separately audited Desktop `0.153.4` recovery path closes ordinary launches
  rejected for a profile mismatch before dispatch, preserving the failure and
  missing lifecycle fields while releasing the unused storage reservation.
  The refusal prevents ticket reuse, and Stop directs recovery instead of
  demanding another launch of the rejected ticket. Qualification carriers
  retain the complete parameter mapping, and missing or malformed qualification
  metadata cannot enter the ordinary recovery path.
- Keep exact-turn Hook receipts separate from the latest task diagnostic, so a
  turnless compaction Hook cannot erase the current turn's observed dispatch.
  Other tasks and unobserved turns still cannot establish readiness.
  Both receipt indexes validate the full audit schema; partial, contradictory,
  unknown-event and bounded-child records cannot establish root-turn readiness.
- Preserve the activated repair through host cache rebuilds by resolving the
  indexed runtime vault and registering a managed marketplace source that
  retains the exact trusted Hook and MCP launch commands.
- Require a Hook receipt from the current native task turn before allocating
  delegation, including lifecycle qualification. Installation startup probes
  no longer imply that an already-running Desktop task has recovered.
- Support the separately audited native macOS CLI `0.153.4` lifecycle stream
  and retain only proven compatible historical shell bindings during refresh.
- Allow explicitly authorized, native-audited requalification after recovery,
  preserving failed attempts and missing handshakes without inventing outcomes.
  Narrow metadata-only recovery auditing remains separate from the no-tool
  qualification contract.
- Normalize explicit targets without mutating immutable policy objects.
- Support the separately audited native macOS CLI `0.153.3` lifecycle stream;
  unknown builds and legacy recovery receipts retain their existing boundaries.
- Restore trusted task routing context inside the same turn after Codex
  compaction through `SessionStart(source=compact)`. Stable identity now accepts
  only non-empty host `session_id`; missing identity is diagnosed with a
  bounded, redacted Hook doctor record, and installer repair migrates the
  deprecated `features.codex_hooks` key to `features.hooks`.
- Preserve old-task shells across later Hook or Skill host-surface changes.
  Repair restores each indexed historical shell to its original immutable
  cache path and validates its own supported Hook set, while the current
  version still fails closed unless it matches the complete current surface.
- A new non-registering `repair` action recovers healthy installations whose
  absolute Node launch fields were overwritten by raw `plugin add`, recreates
  the current Desktop shim after a host-runtime replacement, and proves that
  the materialized MCP and Hook commands still start after that shim is deleted.
  The supported install documentation no longer presents raw registration as a
  complete Desktop-safe installation.
- The one-call stdio bridge now exits with an explicit request timeout when a
  caller opens stdin but never supplies its JSON request, instead of leaving a
  task waiting indefinitely. Frozen-inventory instructions now prefer an
  atomic literal-input command that works on one-shot command surfaces without
  a PTY or `write_stdin`, retain writable sessions only as a confirmed fallback,
  distinguish an unsent request from an internal MCP timeout, and permit one
  corrective retry that does not repeat the bare launch.
- Already-created tasks whose Router function inventory was frozen while MCP
  startup was broken now use a one-call installed stdio bridge for approved
  lifecycle and inspection tools. The bridge invokes the same MCP
  `tools/call`, preserves the Hook-injected context ID, shares the installed
  plugin data directory even when launched from a source checkout, and exits
  after one response. A missing native function no longer forces a replacement
  task or a false local fail-open.
- Compatible upgrades now refresh the live-read bridge helper and skill body in
  every valid v0.4 cache shell, repair all historical bare-Node registrations,
  and install an owned Node shim in Codex Desktop's runtime override directory
  for already-loaded Hook commands. Runtime identities and host registration
  remain unchanged. Explicit current-turn user prohibitions on subagents now
  suppress automatic live routing for that stage.
- Hot refresh now has explicit compatibility boundaries: Skill name/description
  remain fixed identity, while the live-read workflow body and stdio helper are
  accepted only under matching `liveWorkflowContractVersion` and
  `stdioBridgeContractVersion`. The immutable runtime core remains separate
  from the installer-owned launch, shim, Skill-body, and bridge compatibility
  surface.
- Desktop shim recovery is observable and fail-closed: an unresolved platform
  path, unproved ownership, or failed reduced-`PATH` probe can no longer be
  reported as successful old-task continuity.
- Installer-managed MCP and Hook registrations now materialize the qualifying
  Node executable as an absolute, platform-local command before verification.
  This prevents Desktop's reduced GUI `PATH` from making either MCP startup or
  trusted `UserPromptSubmit`, `SubagentStart`, and `Stop` Hooks fail before the
  runtime launcher starts. Compatible upgrades repair the legacy bare `node`
  entries once, stage every new sibling with absolute commands, and verify the
  real installed launch configurations with an empty `PATH`.
- Installer regression coverage now reads the staged `.mcp.json` instead of a
  hard-coded fake transport, launches it under a Desktop-like environment, and
  requires `route_stage` and `record_outcome` discovery, executes the installed
  `router: global on` Hook, and checks its atomic-control context. Future
  upgrades fail closed if either launch surface reintroduces an unresolved
  `node` command.
- Compatible runtime upgrades now stage an immutable sibling without invoking
  `codex plugin add`, so the installer no longer risks removing Router tools
  from already-created Desktop tasks. Host-surface and contract changes stop
  with `HOST_RELOAD_REQUIRED`; the old pinned shell must prove it can activate
  the staged version.
- Upgrade diagnostics and documentation now distinguish new CLI task exposure,
  dynamic MCP path discovery, and same-Desktop-task tool continuity. A task
  whose native Router inventory is frozen continues a compatible v0.4 lifecycle
  through the approved stdio bridge; a genuinely new non-forked task is reserved
  for cold replacement or incompatible contracts. Restart/reopen and fork are
  not presented as native-tool injection.
- Native release gates now require one real Desktop task to stay open across a
  compatible upgrade and complete `route_stage → delegate →
  record_outcome` afterward in the same context. New CLI tasks and synthetic
  same-process probes remain useful evidence but cannot substitute for this
  consumer-identity gate.
- The `v0.4.0` release records a maintainer-authorized, one-time native Windows
  continuity exception. It retains the invalidated Windows `FAIL` artifact and
  still requires macOS native continuity plus hosted Windows CI. The exception
  is hard-bound to the official `v0.4.0` tag workflow and cannot authorize a
  later release.

## [0.4.0] - 2026-07-26

### Added

- A native Windows smoke orchestrator with a two-parameter public interface,
  strict path-free evidence schema, independent status/history/diagnostics
  checks, exact clone-versus-installed revision verification, candidate-local
  test/validate/eval gates, generated Markdown, and a SHA-256 sidecar.
- After initial Hook trust, the Windows orchestrator automatically owns the
  route lifecycle, Sol → Terra → Sol host-model-intent checks, control messages,
  initial-model restoration, and final settled-state verification. Visible
  selector/status-line observations are optional, non-blocking UX evidence.
- A fail-closed macOS evidence template, exact installed ref/revision/version
  verifier, expected-ref/commit validation, and canonical Markdown/SHA-256
  retention flow for the blocking native macOS report.
- Outcome observability that distinguishes explicit `record_outcome` results
  from Stop-auto-finalized `unknown` outcomes without storing prompts or paths.

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

- The installer now reloads Codex plugin state after `plugin add`, validates
  required cached manifests and runtime files when the CLI exposes a cache
  path, and reports `CACHE_DAMAGED: RECOVERY_REQUIRED` when a locked Windows
  replacement leaves an incomplete cache.

- A returned `delegate` action is now explicitly identified in the skill,
  automatic Hook context, and optional managed AGENTS block as the applicable
  skill authorization required by conditional multi-agent policies. Agents
  must launch exactly one bounded subagent instead of presenting delegation as
  a suggestion, silently continuing root-only, or asking the user to authorize
  the route again; actual host-tool rejection still uses the bounded tooling
  failure flow.
- Missing delegated outcomes no longer make the Stop hook inject a continuation
  prompt that can displace the user-facing final reply. The hook now records all
  remaining outcomes as learning-ineligible `unknown` values in one transaction
  and allows repeated or concurrent Stop events to finish silently.
- Release validation now binds the GitHub release workflow, archive, SBOM, and
  provenance artifact names to the package version so stale release tags fail
  before publication.
- Compatible runtime probing and pointer activation are now single-flight
  across concurrent old Hook shells. A slow native-Windows process launch can
  no longer make parallel probes quarantine a healthy runtime or fall back to
  the pinned implementation.
- Bounded subagents are isolated at both `SubagentStart` and
  subagent-marked `UserPromptSubmit`: child models are never observed as root
  model changes, child controls cannot mutate root-task state, recursive
  `route_stage` calls are forbidden, and the root retains Stop/outcome
  ownership.
- Session-disabled routing now emits its own root-only context instead of
  incorrectly presenting the task as `manual_root`; quoted control text
  remains a no-op and live routes continue to report `ROUTER_DISABLED`.
- Exact router controls are explicitly hook-owned: model-visible context and
  Skill instructions forbid duplicate MCP replay and invented context IDs
  after the trusted `UserPromptSubmit` hook has already applied a control.
- Shadow scoring has no route, outcome, proposal, or cursor side effects.
- Shadow output includes numeric before/after counts for all protected routing
  and learning tables, and derives its `sideEffects` flag from those counts.
- Explicit read-only router-inspection turns now suppress the generic automatic
  routing instruction and use a short-lived context guard that rejects an
  accidental live `route_stage` call before it can persist a route. This
  covers status, history, proposal listing, learning status, diagnostics, and
  shadow scoring. Direct inspection requests must name a read-only tool
  immediately after the request verb, so substantive lifecycle prompts that
  later ask for status, history, or diagnostics are not misclassified.
- Proposal status now reports distinct-context, failure, correction, and
  reasoning-retry counts. Rebase keeps the proposal delta while advancing the
  old evidence cursor.
- The v0.3.x → v0.4.0 transition requires one fresh task; later compatible
  runtime-only updates do not. Hook, skill, MCP-schema, and storage-contract
  changes remain explicit restart boundaries.

## [0.3.1] - Included in 0.4.0

This capability fix was merged into v0.4.0 and was not published as a
separate release.

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
