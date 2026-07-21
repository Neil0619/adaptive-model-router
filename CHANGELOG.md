# Changelog

All notable changes to this project are documented here.

## [0.3.0] - 2026-07-21

### Added

- Visible post-route notices that distinguish the unchanged host-managed root
  model from a bounded-stage model/effort target.
- Read-only `get_route_history`, `router: history`, `路由器：历史`, and developer
  CLI history views with timestamps, target transitions, reason codes, and
  outcomes.
- Expanded status reports with current-stage state, route time, reasons,
  transition, and outcome.
- English and Chinese documentation for the exact trigger path and
  deterministic scoring thresholds.

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
