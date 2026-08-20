# Incident: Desktop could not start the Router MCP server or Hooks

## Summary

The installed `.mcp.json` and all three Hook definitions used the bare command
`node`. Interactive shells and the installer could resolve that command, but
Codex Desktop starts these local processes with a deliberately smaller `PATH`.
Desktop therefore failed before either the Router MCP handshake or the trusted
Hook's atomic control handling. Restarting Desktop could not repair an
unresolvable launch command.

The installer now materializes the platform-local absolute Node executable in
the MCP and active-platform Hook definitions of every cache entry it creates or
activates. Compatible upgrades also repair the legacy pinned and target
registrations they use without invoking plugin add/remove.

Two continuity gaps remained after that first repair. A running task retained
its already-parsed bare `node` Hook command, and a task created during the MCP
failure retained a frozen function inventory. The final repair installs an
owned Node shim in Desktop's existing runtime override directory for the former
and a one-call stdio `tools/call` bridge for the latter. Neither path requires a
Desktop restart or a replacement task.

## Root cause

Installation verification tested Router behavior through the installer's own
Node process and a fake Codex transport. It did not launch the exact command
stored in the installed `.mcp.json` under a Desktop-like empty `PATH`. This let
an environment-dependent bootstrap command pass release checks.

The MCP server, runtime launcher, and Router tool implementation were healthy.
Only the first executable lookup failed, before any of those components ran.

## 2026-08-20 recurrence

A later development update used raw `codex plugin add` instead of the managed
installer. That cold registration copied the portable source templates back
into the active cache, replacing the previously materialized absolute MCP and
Hook commands with bare `node`. The failure stayed hidden because the owned
Node shim from the earlier repair still existed in Codex Primary Runtime's
override directory. When Codex updated Primary Runtime, it correctly replaced
that host-owned directory and the plugin-owned shim disappeared with it. The
next Desktop launch could no longer resolve either Router entrypoint.

The first repair did not model this sequence. Its tests covered a managed
upgrade creating and probing the shim, but did not then replace the entire
host runtime directory or run a later raw plugin registration. Release smoke
also exercised the managed candidate, while `codex mcp list` visibility was
treated too optimistically even though registration visibility is not process
liveness. The missed boundary was ownership: a compatibility file placed in a
host-owned replaceable runtime tree can support the current process, but it
cannot be the durable installation invariant.

A follow-up old-task failure had a different cause: the task launched
`stdio-tool.mjs` as a one-shot shell command and never sent its JSON request.
The helper's input timeout fired correctly, but the caller mislabeled that as a
Router transport timeout and failed open. The first correction documented an
exact writable-session sequence (`tty: true`, returned `session_id`, then
`write_stdin`), but the same Desktop task exposed only one-shot command
executions and repeated the bare helper twice. That instruction assumed a
two-tool interaction the frozen task did not actually have. The Skill now uses
one atomic literal-input command as the primary path, keeps writable sessions
only as a confirmed fallback, permits one corrective retry that changes the
failed invocation, and the helper emits an input-specific diagnostic distinct
from an internal MCP timeout.

## Corrective and preventive controls

- First install rewrites bare MCP and active-platform Hook `node` commands to
  the installer's absolute `process.execPath` after Codex creates the cache
  entry.
- Compatible upgrade performs the same one-time repair on a legacy pinned
  shell and every valid historical v0.4 shell, then stages the new immutable
  sibling with an absolute command. Because the host may prune old cache
  siblings during marketplace reconciliation, verified shells are first
  archived in stable plugin data and missing indexed paths are restored before
  this repair.
- An owned Desktop runtime-override Node shim keeps already-loaded bare command
  strings executable until those tasks end. The installer verifies the shim
  under the exact reduced PATH and never overwrites an unrelated valid Node.
  It reports the resolved path and ownership/probe result. If the platform
  location cannot be resolved or the shim cannot be owned and verified, the
  repair fails closed and does not claim existing-task continuity.
- `scripts/stdio-tool.mjs` accepts one approved request, calls the installed MCP
  over stdio, returns the raw structured tool result, and exits. The live-read
  skill uses it only when a native Router function is absent and a trusted Hook
  supplied the exact task context ID. Compatible refresh requires matching
  `liveWorkflowContractVersion` and `stdioBridgeContractVersion`; Skill identity
  remains fixed.
- Source-checkout and installed-cache bridge launches explicitly converge on
  the stable installed plugin data directory, preventing split Router state.
  This is required even on first bridge use when that directory does not yet
  exist; directory existence must never select a fallback database.
- Host-surface compatibility compares the installed absolute Node command to
  the source template's portable `node` placeholder. Other host-surface files
  still require exact equality.
- Installed verification reads the actual `.mcp.json` and `hooks.json`, launches
  their exact active-platform commands with an empty `PATH`, requires both
  `route_stage` and `record_outcome`, and requires the control Hook's atomic
  result context.
- A regression test performs a compatible upgrade, asserts the installed
  command is absolute, and completes MCP discovery with an empty `PATH`.
- A second regression starts from the exact raw-add state, repairs without any
  Codex mutation, deletes the Desktop shim to model a later host-runtime
  replacement, and still launches both installed MCP and Hook contracts with
  an empty `PATH`.
- Verification fails closed if a staged or installed registration still uses
  bare `node`, contains unexpected arguments, or cannot start independently of
  shell configuration.

## Permanent rules

1. Treat the installed launch descriptor—not the source template—as the
   executable bootstrap contract.
2. Every supported host must start the exact installed MCP command with an
   empty `PATH` during installation and release verification.
3. Portable source placeholders may be materialized only by the installer;
   runtime code must never depend on interactive-shell PATH initialization.
4. Compatible repairs must preserve plugin registration and task continuity:
   no plugin add/remove on the hot path, and frozen function inventories must
   retain the same lifecycle through the approved stdio bridge.
5. A Desktop restart is never a substitute for validating every launch command.
6. A release cannot infer old-task continuity from a new CLI task. One real
   Desktop task must remain open across the compatible upgrade and complete
   `route_stage → delegate → record_outcome` in the same context.
7. A file inside a host-owned runtime directory is never durable plugin state.
   Raw plugin registration must be followed by managed repair, and future-host
   startup must succeed after deleting the current-process shim.

## Host recovery boundary

The fixed registration can be installed while Desktop remains open. Already
loaded bare Hook commands resolve through the owned Desktop PATH shim, while
tasks with frozen MCP inventories use the one-call stdio bridge. No MCP reload,
Desktop restart, or replacement task is required for a compatible v0.4 repair,
provided the installer visibly proves the shim/bridge compatibility surfaces.
Failure to locate or verify either surface is a failed repair, not a silent
fallback.
