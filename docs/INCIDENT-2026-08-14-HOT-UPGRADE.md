# Incident: compatible upgrade removed Router tools from existing tasks

> **Superseded recovery conclusion:** the original incident correctly states
> that a task's native MCP inventory is immutable, but its conclusion that an
> already-affected compatible v0.4 task must be replaced was superseded by the
> later approved stdio-bridge repair documented in
> [the Desktop bootstrap incident](INCIDENT-2026-08-14-DESKTOP-MCP-BOOTSTRAP.md).
> The bridge preserves Router lifecycle continuity without claiming to inject
> native tools. A genuinely new task remains required for a cold replacement or
> an incompatible contract change.

## Summary

The compatible-upgrade wrapper invoked `codex plugin add` after refreshing the
marketplace. That command is a host plugin replacement operation. Preserving or
restoring immutable runtime directories kept files available, but it did not
preserve an already-created Codex Desktop task's fixed MCP tool inventory.
Affected tasks therefore failed open and continued without `route_stage` or
`record_outcome`. Restarting Desktop and reopening the task, or forking it, did
not reliably create a new tool inventory.

The corrected compatible path never invokes plugin add/remove. It validates
the installed shell and host surface, atomically stages a higher compatible
runtime beside the pinned shell, then proves that the old shell activates that
exact version. Updates that change MCP registration, Hooks, Skill identity, UI
metadata, or runtime contracts stop with `HOST_RELOAD_REQUIRED` before
requesting host re-registration. The live-read Skill workflow body and stdio
helper may refresh only when `liveWorkflowContractVersion` and
`stdioBridgeContractVersion` match the pinned shell.

## Root cause

Three different continuity properties were treated as one:

1. **Runtime-file continuity:** old immutable cache directories remain readable.
2. **Host-registration continuity:** the installer does not request plugin
   replacement or re-registration while Desktop is live.
3. **Task-tool continuity:** the same already-created Desktop task retains its
   original Router MCP tools.

The previous fix protected only the first property. It ran `plugin add`, then
restored removed cache directories and verified a direct MCP process plus a new
disposable CLI task. Those checks could pass while the original Desktop task
had already lost its tools. Fail-open behavior limited the blast radius, but it
also made the regression look like a recoverable routing fallback instead of a
failed upgrade.

## Contributing factors

- Installation success, direct MCP discovery, new CLI task exposure, and
  same-Desktop-task continuity were not labeled as different evidence scopes.
- Recovery guidance implied that restarting or reaching another stage boundary
  could repair a task whose tool inventory was already fixed without Router.
- The upgrade design assumed cache restoration could undo a host lifecycle
  mutation.
- Version cachebusters had mixed UTC and local-time conventions. The monotonic
  version guard caught the resulting backwards identifier during this repair;
  release tooling must pass an explicit monotonically increasing token until
  one time basis is standardized.
- Codex may dynamically resolve a later `mcp list` query to a newly staged
  sibling. That discovery must not be confused with the installer invoking
  plugin re-registration or with an existing task changing its inventory.

## Corrective and preventive controls

- Compatible upgrades use immutable sibling staging and atomic rename only.
- `plugin add` is confined to first install, damaged recovery, or an explicit
  cold host-surface replacement after Codex processes are fully stopped.
- Host-surface and shell/tool/storage contract changes fail closed before the
  hot path mutates registration.
- The old pinned MCP shell must diagnose the newly staged runtime version.
- Regression tests model `plugin add` as destroying a live Desktop task's tools
  and assert that compatible upgrade never calls it.
- Tests cover both possible host discovery results: MCP listing the old shell
  or resolving to the newly staged sibling.
- CLI smoke output is explicitly labeled as CLI evidence and cannot be used as
  proof about an already-created Desktop task.
- A frozen native inventory uses the approval-limited stdio bridge for
  compatible v0.4 continuity; cold replacement and incompatible contract
  changes still require a genuinely new non-forked task.
- Release acceptance keeps one real Desktop task open across the compatible
  upgrade and requires an ordered `route_stage → delegate →
  record_outcome` lifecycle in that same context.

## Permanent rules

1. A hot-upgrade path must perform zero host plugin registration mutations.
2. Prove runtime-file, host-registration, and same-task-tool continuity
   independently; evidence for one never substitutes for another.
3. Verify continuity against the same consumer identity. A new CLI task cannot
   prove an old Desktop task remained healthy.
4. Treat task MCP inventory as immutable. Restart/reopen and fork do not add
   native tools; compatible lifecycle continuity for a frozen inventory is
   provided by the explicit bridge contract.
5. Fail-open is a safety fallback, not successful upgrade evidence.
6. Reject host-surface or contract changes from the hot path and print an exact
   cold-replacement boundary.
7. Keep immutable runtime versions strictly monotonic and use one explicit time
   basis for cachebusters.
8. Never describe dynamic MCP path discovery as proof that an existing task's
   tool inventory changed.

## Remaining host boundary

The plugin cannot inject native functions into a task that the Codex host
created without them. The later compatibility repair routes an already-affected
v0.4 task through the approved stdio bridge instead, so replacement is not
required for a compatible upgrade. Cold replacement and incompatible fixed or
workflow contracts still require Hook review and a genuinely new non-forked
task. Neither recovery path claims to rewrite historical host inventory.
