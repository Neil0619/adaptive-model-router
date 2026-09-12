# Troubleshooting

Start with the redacted `diagnose_router` tool. For source-tree development,
the equivalent command below diagnoses the current repository project:

```bash
node plugins/adaptive-model-router/scripts/codex-route.mjs doctor --context troubleshooting
```

For another project, keep that project as the working directory and invoke the
script by its absolute path.

Do not paste prompts, source files, secrets, absolute project paths, SQLite
files, or Codex credentials into a public issue.

## Plugin or tools are missing

1. Confirm the marketplace and plugin are visible:

   ```bash
   codex plugin marketplace list
   codex plugin list
   ```

2. For a compatible runtime-only update, use the managed upgrade:

   ```bash
   ./install.sh upgrade
   ```

   The wrapper stages a new immutable sibling and verifies it through the
   previously pinned MCP shell. It does not call `plugin add` or request plugin
   re-registration. Before marketplace refresh it archives all verified
   compatible shells in stable plugin data; after refresh it reloads the actual
   registration and restores indexed historical paths that Codex cache
   reconciliation pruned. Codex may resolve later `mcp list` queries to the
   staged sibling; this does not alter an existing task's fixed tool inventory.
   The reviewed residency repair has a narrowly scoped in-place path:
   `node scripts/manage-install.mjs repair --non-interactive --refresh-host-surface --verify-task-tools`
   from its candidate plugin root. It permits only the reviewed Hook matcher
   expansions and additive maintenance interface. Existing tasks use the stdio
   bridge if their tool inventory is frozen. Refreshing files does not certify
   live Hook dispatch; review any changed Hook hashes and verify the existing
   task before reporting recovery.
   If it reports `HOST_RELOAD_REQUIRED`, fully exit
   Desktop and all other Codex CLI processes, then run the exact cold
   replacement command it prints from a fresh terminal. Review Hooks and create
   a genuinely new non-forked task afterward; do not present that operation as
   a hot upgrade.

   The wrapper also materializes an absolute Node executable in the installed
   MCP transport and every active-platform Hook command, then verifies those
   exact commands with an empty `PATH`. This is required because Desktop's GUI
   process may not inherit `/usr/local/bin`, an NVM directory, or another
   interactive-shell Node location. Legacy bare `node` entries are repaired
   once; later compatible upgrades inherit the same invariant and fail rather
   than reporting a false success.

   If raw `codex plugin add` was run after the last managed install, or a Codex
   update replaced the Desktop runtime directory that held the compatibility
   shim, repair the healthy registration in place:

   ```bash
   ./install.sh repair
   ```

   ```powershell
   .\install.ps1 -Action Repair
   ```

   Repair performs no marketplace mutation and no plugin re-registration. It
   recreates the current-process shim, rewrites every compatible installed MCP
   and active-platform Hook launch field to the qualifying absolute Node path,
   and verifies those exact commands with an empty `PATH`. Those materialized
   commands remain valid after a later host-runtime replacement even though the
   temporary shim is host-directory scoped.

   For already-loaded bare Hook commands, the installer must also print the
   owned Desktop shim path and prove that exact shim under Desktop's reduced
   `PATH`. An unresolved platform location, an existing unowned shim, or a
   failed probe is a failed continuity repair. Do not interpret a skipped shim
   as successful in-place recovery.

   `codex mcp list` proves only that a registration exists; it does not prove
   that Desktop successfully spawned the stdio process or completed the MCP
   handshake. Use the repair probes or an actual Router tool call as liveness
   evidence.

   Hook trust is recorded against the exact definition hash. The one-time
   repair changes that definition, so review and trust the repaired Hooks once.
   Compatible upgrades that keep the same materialized executable retain the
   same definition and do not create a new trust prompt.

3. On a first install, a v0.3.x → v0.4.0 upgrade, or an incompatible contract
   update, create a genuinely new non-forked Codex task after the required Hook
   review. For a compatible v0.4 update, a task whose native Router functions
   were already lost uses the installed one-call stdio bridge instead; do not
   replace the task merely to rebuild its fixed tool inventory.

   The bridge accepts one approved Router tool request, invokes the same MCP
   `tools/call`, and exits after its response. It requires the exact context ID
   injected by a trusted Hook and never invents one. Hook, native MCP, installed
   cache bridge, and source-checkout bridge all resolve the same stable plugin
   data directory. A transport failure is reported as a bridge failure, never
   disguised as a `route_stage` `continue` result.

   Starting `stdio-tool.mjs` as a one-shot command without an stdin payload
   never calls Router. With a one-shot POSIX command tool, include the one-line
   JSON in the same command through a quoted literal here-document; with
   PowerShell, pipe a literal here-string to the helper. This path does not need
   a PTY, session ID, or a second `write_stdin` call. Use the writable-session
   sequence only when the host actually returns such a session. An error saying
   "timed out before receiving JSON" is a caller input-delivery failure; retry
   once with the atomic literal-input form instead of repeating the bare launch.
   It is distinct from `stdio bridge timed out`, which means the request was
   received but the internal MCP call did not finish.

4. After trusting the current Hooks, a cold first install with
   `--verify-task-tools` or `-VerifyTaskTools` uses one disposable Codex CLI task
   and fails unless `diagnose_router` and `route_stage` both complete. A
   compatible `upgrade --verify-task-tools` deliberately does not create a new
   task; it runs only pinned in-place MCP, Hook, and stdio-bridge probes because
   a fresh CLI task can trigger host cache reconciliation. Neither check proves
   that an already-created Desktop task retained its fixed tool inventory; use
   the same-task release gate below for that claim.

If a verification failure is followed by `HOT_UPGRADE_ROLLBACK_FAILED`, stop
all affected Router processes and preserve the recovery-snapshot identifier printed
by the wrapper. It identifies a directory under the system temporary directory.
The installer deliberately retains that complete tree instead of deleting the
last known-good backup; restore or inspect it before retrying any lifecycle
command.

`RUNTIME_VAULT_DAMAGED`, `RUNTIME_VAULT_ARCHIVE_FAILED`, or
`RUNTIME_VAULT_RESTORE_FAILED` is not a normal routing fallback. The installer
has refused to trust or replace a historical shell. Preserve the stable plugin
data and installed cache, verify that `runtime-shell-vault/index.json` and every
indexed directory came from reviewed plugin packages, and repair from the exact
reviewed versions before retrying. Do not delete the index, bypass symlink
checks, or run `plugin add` while existing tasks depend on those paths.

`INSTALLER_LIFECYCLE_BUSY` means another install, upgrade, or uninstall owns
the plugin-data SQLite lifecycle transaction. Wait for that process to finish
and retry. Do not delete the lock database: SQLite releases the transaction
automatically if its owner exits or crashes, and the next wrapper run can then
restore any indexed cache paths pruned before that crash.

If marketplace refresh itself fails, the wrapper restores every indexed
missing or damaged historical shell before returning the refresh error. A
`MARKETPLACE_RECOVERY_FAILED` result is stronger: preserve both plugin data and
the host cache, because the wrapper could not prove that all old-task paths were
recovered.

An installed runtime containing a symbolic link, duplicate enabled Router MCP
registration, or changed cache-directory identity is treated as damaged. The
wrapper stops before replacement; inspect the cache and registration rather
than bypassing this guard.

If a marketplace named `adaptive-model-router` points to a different source or
ref, the wrapper stops rather than replacing it. Inspect the marketplace list
and remove it only after confirming it belongs to this plugin.

Release maintainers can pass an explicit reviewed candidate ref with
`./install.sh --ref=<ref>` or `.\install.ps1 -Ref <ref>`. Use the same ref for
install, upgrade, and uninstall. Ordinary users should omit this option and
remain on the default protected `stable` branch.

## Hooks are installed but do not run

Plugin installation does not automatically trust command hooks. In Codex, open
`/hooks`, review the installed definitions, and trust the handlers whose current
hashes are not already trusted. The seven Router handlers are:
`SessionStart(source=compact)`, `SubagentStart`, `SubagentStop`,
`PreToolUse` (managed child tools and messages), `PostToolUse` (spawn, message,
followup, list and interrupt receipts), `UserPromptSubmit`, and `Stop`.
Trust is tied to the definition hash, so changed hooks require review again.

If a task reports that no trusted `contextId` is available after compaction,
run `node scripts/codex-route.mjs hook-doctor --context <native-task-id>` from the
installed plugin root with its `PLUGIN_DATA` environment. `CODEX_THREAD_ID` is
the default task when the host exposes it; `--turn <native-turn-id>` narrows the
check to that turn. `HOOK_DISPATCH_NOT_OBSERVED` means no matching retained
Router identity Hook receipt exists for that task or turn;
`HOOK_DISPATCHED_MISSING_SESSION_ID` means the Hook ran but Codex supplied no
stable `session_id`. The report never contains the raw session or turn ID.
`--global` explicitly reads the latest observation from any task; its
`scope=global_latest` is never evidence for the task under investigation.
An inventory of trusted Hook definitions likewise does not prove dispatch.
`contextInjection=context_emitted` confirms Hook output was emitted, not that
the host consumed it; check the native task record for that final boundary.

If delegation worked before a host cache refresh, compare `runtimeVersion`,
`requestedActiveVersion`, `activePointerStatus` and `activeSource` in runtime
diagnostics. The loader can use the indexed active backup in stable plugin
data without another installer run. Also update the source registered in the
local marketplace: a repair that exists only in a separate worktree or cache
can be lost on the next refresh. A missing or invalid backup is reported as
`activePointerStatus=unavailable`; do not call that state fully recovered.

For an exact local repository registration, run
`node plugins/adaptive-model-router/scripts/manage-install.mjs repair --pin-local-marketplace`
from that repository. This switches the native marketplace source to a verified
materialized generation in stable plugin data, retaining the installed Hook
bytes and launch paths. Subsequent managed repairs and upgrades refresh the
generation from the original checkout. A cache rebuilt solely from this source
must run the Hook and an actual MCP tool call with an empty `PATH`; an MCP
initialization response alone does not prove runtime recovery. The installer
retains prior generations and writes recovery evidence if source verification
or conditional rollback fails. It never writes Hook trust state.

Do not use `--dangerously-bypass-hook-trust` for normal installation or smoke
testing. Also check that hooks have not been disabled by local or managed Codex
configuration.

## Routing stays root-only because lifecycle Hooks are not ready

Before it can return `delegate`, the Router reads the current Hook inventory
through Codex's read-only `hooks/list` API and checks a task-scoped Hook receipt
against the latest native turn from `thread/turns/list`. A fresh app-server's
inventory does not establish that an already running Desktop task loaded the
plugin Hooks. It never accepts Hook trust automatically.

- `HOOK_TRUST_REQUIRED`: at least one exact current Router Hook is disabled or
  not trusted. Review `/hooks` and explicitly trust the definitions if they are
  expected.
- `HOST_HOOK_SET_MISMATCH`: the host-loaded Router Hook definitions do not
  exactly match the active plugin installation. Reinstall or repair the plugin,
  then inspect the current task again. A compatible runtime repair can continue
  in the same task after its fresh qualification succeeds.
- `HOST_HOOK_STATUS_UNAVAILABLE`: the read-only inventory could not be obtained.
  Keep working in the root task and diagnose the Codex/app-server availability;
  do not retry delegation in a loop.
- `HOST_HOOK_DISPATCH_NOT_OBSERVED`: the exact latest native turn has no Router
  Hook receipt. Check the live Desktop task's Hook events, not only a new
  process's inventory. User-level Hooks can run while plugin Hooks are absent.
  A native `config/batchWrite` with `reloadUserConfig: true` refreshes runtime
  settings only in that app-server's loaded threads; launching a separate CLI
  app-server does not refresh Desktop. Use an available native host refresh
  capability, or explicitly report that the running host must be reloaded. Do
  not ask for trust again when the seven exact definitions are already trusted,
  and do not allocate another qualification until the affected turn has a real
  receipt. This failure creates no ticket or reservation.
  Exact-turn receipts are retained separately from the latest task diagnostic:
  `SessionStart(source=compact)` may omit `turn_id`, so it must not overwrite
  the current turn's proof or infer a new turn. Previously erased proof requires
  another real native prompt/Hook dispatch; it is never reconstructed by hand.
  Both the new turn index and legacy fallback require a complete, consistent
  audit schema. A matching turn digest alone is insufficient, and a malformed
  new index cannot fall back to an older record.
- `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`: the trusted inventory does not have a
  source-owned native proof that the exact host Agent path dispatches the
  complete lifecycle. Continue in the root task; trust alone is not a fix.

All five results create no Agent, no delegation ticket, and no occupied gate.

`HOST_LIFECYCLE_QUALIFICATION` is a distinct `delegate` result on supported
native macOS builds and Windows Codex 0.153.4: launch its exact fixed no-tool carrier
once, verify the child, and record the outcome through MCP. The server audits
the native lifecycle and complete raw transcript itself; a caller's passed
flag is insufficient. After success, route the original stage again.
`HOST_LIFECYCLE_QUALIFICATION_FAILED` keeps the task root-only after a failed
self-test. A changed binding can receive a fresh fixed qualification only when
the previous source-verified proof, original route, and successful outcome are
intact, the current Hook inventory is trusted, and no child is unresolved. The
old proof is archived atomically, preserving its route and outcome. This applies
to compatible runtime, Hook-cache, and supported host-build upgrades. The next
`route_stage` admits only a fresh no-tool qualification, without an operator
requalification grant or diagnostic capture. Readiness also retains the parent/child Hook
shells actually observed by that proof, after checking that their current
definitions are equivalent and their compatible runtime trees have no symbolic
links. An open task may still use an older child shell after the configured
cache advances. Ordinary work stays disabled until the new native round trip
passes. Failed, pending, invalid, and ambiguous attempts do
not receive automatic replacements. If a gate remains occupied, preserve the
evidence and follow the existing reconciliation rules.

### Recover an ordinary launch rejected before dispatch

Every routed `spawn_agent` call must explicitly pass `task_name`, `message`,
`fork_turns: "none"`, `model: target.model`, and
`reasoning_effort: target.effort`. The root model and its selected effort are
not substitutes for those host parameters. The automatic Hook context repeats
the complete mapping so a resumed turn does not depend on recalling the skill.

A profile mismatch is correctly denied by `PreToolUse` and marks the attempt
as requiring reconciliation, preventing reuse even with corrected parameters.
Stop directs native recovery instead of demanding the same launch again.
That refusal does not consume the ticket, record an outcome, or by itself release the reservation.
Continuing in the root leaves the task gate occupied and can also exhaust the
host-wide reservation budget. Do not call the failure harmless or retry the
same ticket.

Resolve the current Router local `source.path` from `codex plugin list --json`
and verify its manifest version against the diagnosed active runtime. This
avoids invoking an older immutable CLI from a long-lived skill's cache path.
From the affected project's working directory, inspect the exact attempt with
that source's `scripts/reconcile-delegation.mjs --context <task-id> --route <route-id>`.
The separate `native-thread-predispatch-rejection-recovery/1` adapter accepts
only the reviewed Desktop `0.153.4` ordinary profile-mismatch refusal. It reads
the native parent source and full task projection twice, binds one direct call
to its exact host-authored rejection, and rejects duplicate calls, child
activity, unsupported records/builds, truncated source and changed state.
An assistant's explanation or a generic tool error cannot authorize release.

When inspection returns `recoverable` with `recoveryKind: rejected_before_dispatch`,
preserve a database backup and apply that exact fresh digest using
`--apply --expect-digest <digest>`. Recovery of this bounded Router failure is
within an already-authorized task or repair; do not ask for approval again.
The transaction revokes only that ticket, retains a distinct failure receipt,
and releases its unused reservation. Missing lifecycle fields stay missing;
no outcome or successful review is invented. Parent-source bytes are audit
evidence, not child storage usage. Unrelated progress by the parent may continue
between inspect and apply, while new conflicting launch evidence blocks it.
Check Router status after applying. A still-needed review requires a fresh
route; a completed stage does not need to be repeated merely to fill a record.
Qualification failures retain the separate procedures below.
The persisted route class also guards this boundary: missing, invalid, or
mismatched qualification metadata cannot make a self-test eligible for ordinary
recovery. The final transaction rechecks that route and qualification state.

### Recover a native agent-count rejection after dispatch

The exact Desktop `0.153.4` response
`collab spawn failed: agent thread limit reached` has a separate recovery path.
Here PreToolUse has consumed the ticket but the host may provide no PostToolUse
callback or child identity. A failed outcome alone cannot free the reservation.

The MCP `record_outcome` mutation automatically audits this case after storing
an ordinary failed/tooling outcome. If it reports `delegationRecovery` with
`gateReleased: true`, check status. Existing stuck attempts, or attempts without
an outcome, use the current installed `reconcile-delegation.mjs` command above.
Inspect first and apply only `recoveryKind: host_agent_limit_rejected` with its
fresh evidence digest; preserve a database backup before operator application.

The adapter binds the original direct call, five exact arguments, trusted
PreToolUse input digest, exact native refusal, full parent projection, route
class and retained outcome. It audits complete native source snapshots twice,
streaming at most one JSON record at a time. Bounds are 512 MiB per parent,
16 MiB per record and 100,000 records; larger or partial logs fail closed.
It tolerates unrelated parent progress but rejects replay, conflicting child
activity, unknown builds/records, file replacement and changed database state.
The transaction preserves existing outcomes and missing lifecycle observations,
records a separate recovery receipt, revokes the ticket and frees its reservation.
Neither a fake PostToolUse nor a new outcome is needed to release that attempt.

Status then distinguishes an available `delegationGate` from a task-scoped
`hostCapacityRejection`. The refusal remains history, not a permanent ban on
delegation. At the next real stage, `HOST_CAPACITY_RECHECK_REQUIRED` requests
one native `list_agents` observation. Complete current work or use bounded old
child maintenance when required, then request a new ticket for the same
still-needed stage. One recovery startup per stage and native root turn is
allowed; do not retry the failed ticket or duplicate its outcome.

`HOST_CAPACITY_TEMPORARY_BUSY` and `HOST_CAPACITY_RETRY_EXHAUSTED` leave the
current work with the root until a later real delegation rechecks capacity.
Required independent review remains pending for an actual child, and active
maintenance blocks conflicting admission. No timeout, marker deletion, higher
native limit or reuse of a settled child for new business proves recovery.
A malformed retained receipt remains guarded with
`HOST_CAPACITY_EVIDENCE_UNPROVEN`; routing for other root trees is unaffected.

### Inspect a failed qualification without resetting it

The operator-only `scripts/reconcile-delegation.mjs` defaults to inspection.
Run it with the affected project's working directory, not the plugin-cache
directory, and use an absolute path to the script when necessary:

```sh
node /absolute/plugin/scripts/reconcile-delegation.mjs --context <task-id> --route <route-id>
```

The unconsumed-child recovery uses a separately pinned raw adapter for the
child's actual `0.153.0-alpha.5`, `0.153.3`, or `0.153.4` build; an older parent
task's version metadata is not substituted for that build. A retained pending
qualification additionally binds its original policy, ticket and child build.
Successful recovery preserves that qualification and all missing lifecycle
fields, records a distinct failure receipt, accounts physical bytes once and
releases only that reservation. It creates no ordinary outcome or passed proof.
For `0.153.4`, a distinct `tool-metadata-only/1` audit also recognizes the single
reviewed literal program that only filters and prints `ALL_TOOLS` descriptions.
It does not evaluate arbitrary JavaScript, accept general read-only tool calls,
or relax the no-tool qualification audit. Its receipt retains the complete raw
source digest, byte count, query digest and metadata-call count. Extra code,
extra calls, missing outputs and unknown actions remain unresolved.
A separate `native-thread-delegation-recovery/3` branch accepts only
the supported `0.153.0` failed no-tool qualification: exact consumed Pre/Post,
no child claim or Stop, one retained tooling-failure outcome, matching stored
qualification binding, one native completed child, and two stable complete raw
no-tool audits. Hidden actions, changed identities, duplicate/resumed children,
incomplete source records, and state changes remain unresolved. Historical
parent metadata does not replace the qualification's actual child-build binding.

`recoverable` is not an applied recovery or permission to retry. After separate
operator approval and a database backup, `--apply --expect-digest <digest>`
revalidates the sources and exact durable state in the final transaction. It
preserves the failed outcome and qualification, leaves missing lifecycle fields
missing, records a distinct recovery receipt and accounts physical bytes once.
It does not reset qualification, enable ordinary delegation, or create a child.
Investigating missing Start/Stop still requires actual Hook-event evidence;
successful recovery alone does not repair that dispatch path.

### Explicitly authorize one diagnostic requalification

An unused authorization expires after one hour and becomes stale when its
source/configuration binding changes. If either occurs, inspect again with the same operator command and
approve its newly returned digest. The command repeats the native source audit,
archives the exact stale authorization, and grants one fresh window. The old
preview cannot renew it, and a consumed authorization cannot be renewed. Neither
inspection nor ordinary routing renews a grant automatically.

Only after the operator approves another fixed no-tool self-test, use
`scripts/authorize-requalification.mjs` from the affected project directory.
Run the script from the installed package so its binding reflects the installed
runtime. It requires a retained native recovery receipt bound to the unchanged
qualification (either an unconsumed pending qualification or the original `/3`
failed qualification), or a finalized qualification that failed with
`HOST_HOOK_SET_MISMATCH` while its correlated child completed without work.
The latter path independently re-reads the complete native child twice and
verifies its original marker, model, parent, raw transcript, and retained
tooling-failure outcome. It never converts that failed attempt into a success:

A Desktop upgrade can also expose an older standalone CLI earlier on PATH.
On macOS, qualification now identifies the actual Codex process in its bounded
parent-process chain and verifies that executable, while ordinary CLI command
discovery is unchanged. Unknown or changing process identity fails before a
qualification ticket is issued. The reviewed macOS `0.154.0-alpha.6.2` no-tool
record format has its own exact adapter; adjacent builds and native Windows
on that build remain unqualified.

Version-pinned followup rejection parsing uses a per-call host measurement from
the real message Pre Hook. A task's initial `session_meta.cli_version` remains
its creation version after resume and cannot establish the sender's current
version. The Hook binds the measured native executable to the exact sender,
call, turn, tool and input digest. Missing, changed, conflicting or unknown
call-time evidence retains the message as pending; a later MCP process or PATH
CLI cannot supply it retroactively. Existing verified rejection receipts remain
usable only while their exact original native evidence still matches, without
inventing a historical host measurement. Call-time process attestation currently
requires a proven macOS Codex ancestor; other hosts retain uncertain errors.

An already completed qualification rejected as
`NATIVE_QUALIFICATION_EVIDENCE_UNPROVEN` may use the same one-use operator flow
only when the full native audit proves its child ran a different, explicitly
reviewed build from its retained binding. All four original Hook observations
must still match that original binding, and the child must have exactly one
completed no-tool turn with the original marker and verified parent. Same-build
failures, unknown builds, missing Hooks, or hidden work remain unresolved. This
audit preserves the original failed outcome and authorizes only a new no-tool
qualification against the currently verified runtime and host.

```sh
node /absolute/plugin/scripts/authorize-requalification.mjs --context <task-id> --route <failed-route-id>
node /absolute/plugin/scripts/authorize-requalification.mjs --context <task-id> --route <failed-route-id> --approve-one-no-tool-requalification --expect-digest <fresh-inspection-digest>
```

The authorization expires after one hour and binds the task, recovered state,
current runtime, executable/Hook configuration, and task directory. Inspection
does not authorize anything. Admission atomically archives the complete old
qualification and consumes the authorization while creating one new
fixed qualification; the original route, outcome and recovery receipt remain
unchanged. Replay, expiry, changed sources or state, and another occupied gate
cannot create a replacement. There is no public MCP permission flag or model
override for this operation, and it never directly enables ordinary delegation.

The same authorization temporarily enables task-scoped lifecycle diagnostics.
Records contain only enumerated stages/reasons, field types, hashes and boolean
identity comparisons, never prompts, carriers, tool input/output or raw paths.
The current writer requires private POSIX file modes and refuses output when
group/other permission bits are present. Windows does not expose that private-mode
attestation through Node's file modes, so its CI checks refusal rather than claiming
successful capture. Native Windows capture qualification remains deferred.
The private diagnostic file is bounded to 64 KiB per run (concurrent writers can
add at most their already-bounded pending records). These observations help
locate a failure; they are not admission or lifecycle proof. Disable capture
after the one test, including when it fails:

```sh
node /absolute/plugin/scripts/authorize-requalification.mjs --context <task-id> --close-diagnostics
```

Closing capture rejects newly started records; it is not an I/O drain barrier.
A bounded record that passed its authorization check before closure or expiry
may finish afterward, just as concurrent writers may finish within the stated
in-flight allowance above. Close capture after the self-test's complete terminal
verification, not as a substitute for waiting for that verification.
Closing capture never re-arms authorization or changes a qualification result.
The diagnostic facility remains inactive by default and automatically expires;
retained redacted evidence lives under the plugin data `diagnostics/` directory.

## A child has finished but its stage still has pending work

Inspect `get_route_status.stageClosure` first. A final reply, successful
`followup_task`, or completed outer code cell does not close an underlying
process or acknowledge an omitted requirement. Follow its specific next action:
continue the same stage, wait for the existing operation, or reconcile its
original message call. Native Bash completion and matching command/patch
terminal events normally settle execution automatically, including nonzero
results; the root must still verify the task result.

For a missing or conflicting execution receipt, call `manage_stage` with
`action: "read_operations"`, the exact route and current `expectedRevision`.
It returns operation identities, source references and `snapshotDigest`.
This inspection is strictly read-only. Adopt an unregistered historical child
only through explicit `reconcile_messages` with its exact native identity.
An older opaque code-mode call without proven command coverage stays unknown
after its outer cell completes; inspect its actual inner operations instead of
polling a guessed handle. A late poll result cannot settle a newer operation
that happens to reuse the old process handle.
After inspecting the original evidence and any necessary actual verification,
use `reconcile_operations` with `operationReview`: the snapshot, individually
named operations, original and verification references, conclusion, basis and
result review. A verified root judgment may establish `not_started`,
`completed` or `stopped`. `unresolved` retains its source, owner, next step and
resume condition. An existing handle or execution result cannot become
`not_started`; cancelling the stage or submitting an empty pending array cannot
clear execution. Changed inputs, receipts or commands require a new snapshot.

The action appends a private review and invalidates old verification; it does
not create an outcome or claim business success. Inspect closure again and
verify the current result before settlement. Frozen tool inventories can call
these additive actions through the installed `stdio-tool.mjs` bridge. A new
bounded maintenance cycle after verified collection preserves earlier
dispositions and accounting and requires a fresh followup and final result.
Use normal routing and a new child for a new business stage.

Repeated maintenance must preserve the previous verified dispositions. Resolve
completed or explicitly changed responsibilities through `resolve_requirements`;
another collection cannot silently turn transferred work into `no_work`.
While maintenance is active, ordinary admission remains paused. An exact native
Pre refusal of a message is recorded as rejected and stays with its sender;
generic or uncorrelated errors remain pending until their actual result is known.

For native final replies containing memory citations, the raw message and Stop
can contain different text representations. The reader requires the same child,
turn and message identity, exact citation metadata, and matching native completed
text before accepting the alternate Stop digest. The complete response remains
bound into result verification. Do not edit the transcript, strip citations,
manufacture Hook records or send another final solely to mask this difference.

If the installed runtime and trusted inventory are current but an old task
still emits no required tool callback, record that actual failed self-test and
use the existing plugin reload mechanism before retesting. Fresh-process Hook
trust and an MCP hot upgrade alone do not prove that an old task loaded its
new Hook definitions. Do not repeatedly create children to test a known stale
loaded definition, erase its reservation, or claim an independent review ran.

## A child fails with an encrypted-content decode error

Do not retry the same route. First inspect how `spawn_agent` was invoked. The
supported Router path is the direct native collaboration tool call outside
`functions.exec`. A spawn function discovered only through code mode or
`ALL_TOOLS` inside an exec cell is not equivalent: that path can pass literal
plaintext where the v2 collaboration runtime expects host-encrypted message
content.

Report that host as `hostCapabilities.delegation.available: false` with
`invocation: "code_mode_nested"` and an empty target list. The Router then
returns `continue / HOST_DELEGATION_UNAVAILABLE` and performs the stage in the
root. Preserve the failed attempt for lifecycle audit until its child terminal
state is proven; never fabricate a no-child result or launch a replacement into
the occupied gate.

On a host with the direct native tool, pass the carrier unchanged with
`fork_turns: "none"`. The Router `PreToolUse` hook validates and consumes the
ticket but intentionally emits no `updatedInput`, so Codex retains ownership of
the encrypted message envelope.

## Ordinary tasks do not trigger automatic routing

Installation deliberately leaves global automatic routing off. In a trusted
new task, opt in once for the shared local Codex Home:

```text
router: global on
```

The setting persists across projects and restarts. If the command succeeds but
ordinary substantive tasks still receive no router context, re-open `/hooks`,
trust the current `UserPromptSubmit` definition, and start another new task.
Hook trust is hash-specific when an upgrade changes the Hook definition.
Compatible implementation-only runtime updates keep the stable definition and
do not require renewed trust. Simple questions and stages with no work product
may still continue in the root task by design.

## A bounded subagent asks whether its model change was manual

This indicates that an old hook treated the child's model as a new root model
and recursively injected automatic routing. Upgrade to the current v0.4
candidate, review all seven changed hook definitions, and start a fresh task.
In the fixed version, `SubagentStart` and subagent-marked prompt hooks tell the
child to execute only its assigned scope. The child must not call
`route_stage`, change model-intent state, or own `record_outcome`; the root
task verifies and records the outcome.

## Runtime pointer is absent

A missing plugin-data `runtime/active.json` can be normal when only one
compatible runtime exists and no cross-version trial has been activated. With
no pointer, the loader reports `activePointerStatus=unset` and uses its current
compatible runtime as the active baseline. A newer compatible sibling can
still be tried; the missing file does not disable upgrades.

Inspect `diagnose_router.runtime` for the actual `runtimeVersion`,
`activeVersion`, `activePointerStatus`, and `activeSource`. A pointer that names
an unavailable runtime instead reports `unavailable` and `fallback`; this is a
different condition from a normal missing pointer. An `unset` result alone also
does not prove the file was absent, because unreadable or malformed pointers
are treated as empty. Investigate an unexpectedly lost activation record; do
not manufacture or edit a pointer by hand.

An existing pointer must contain only safe directory names, never absolute
cache paths. Neither its presence nor its absence is same-task hot-upgrade
evidence: the smoke still requires one unchanged Desktop task/context, an
advancing runtime, an unchanged root model, a completed delegate/outcome, and
the required transport/shim observations.

## An existing task still reports the old Router runtime

Call `diagnose_router` in that task and inspect its redacted `runtime` object.
For a compatible update, `runtimeVersion` and `activeVersion` should advance on
the next MCP call. `previousVersion` is the rollback target and
`failedRuntimeCount` reports quarantined candidates without exposing paths.

If it does not advance:

1. Confirm the new immutable sibling was staged by the wrapper. Depending on
   host discovery timing, `codex mcp list --json` may point to either the
   previous shell or the staged sibling; the installer must accept both and
   separately verify the previous shell can activate the staged runtime.
2. Run `npm run validate` in a source checkout and confirm `runtime.json`
   matches the plugin manifest.
3. Check whether the new version changed the shell protocol, tool schemas,
   storage contract, `liveWorkflowContractVersion`, or
   `stdioBridgeContractVersion`. Such a version is intentionally ignored by the
   old shell and needs a cold replacement plus a new task.
4. If `failedRuntimeCount` increased, the old shell rejected the candidate's
   contract probe, isolated database probe, or first real initialization and
   kept the prior runtime active. Reinstall a fixed, higher version; do not edit
   the pointer by hand.

Hook definitions, MCP schemas, Skill identity metadata, and the native function
inventory remain task-pinned. The Skill body is live-read, but it may be
refreshed in a compatible upgrade only when its declared
`liveWorkflowContractVersion` matches; the helper likewise requires a matching
`stdioBridgeContractVersion`. If an update changes Hook JSON, adds a native tool, or
changes either workflow contract incompatibly, review the Hook/contract and
start a new task after a cold replacement.

## A task says Router MCP tools are unavailable

Task tool registration is fixed when that task starts. If its initial tool
inventory never contained `route_stage`, `record_outcome`, or
`diagnose_router`, a later plugin upgrade cannot add native functions to that
same inventory. Restarting Desktop or forking does not change that fact.

For a compatible v0.4 repair, this is not a reason to replace the task. The
live-read Skill must use the installed, approval-limited stdio bridge with the
trusted Hook's exact context ID. Verify that the bridge reports its transport,
uses the stable installed plugin data directory, and can complete the required
lifecycle. A bridge startup or storage error is a tooling failure; it must not
be presented as a normal `continue` route.

Create a genuinely new non-forked task only after a cold install/replacement or
an incompatible fixed/workflow contract change. A task that already owns the
pinned Router MCP shell continues through its native functions; a frozen task
continues through the bridge. Neither path claims that the host inventory was
mutated.

Release acceptance requires more than the installer's in-place probes: keep one real
Desktop task open across the compatible upgrade and prove, in that same task
and context, one ordered `route_stage → delegate → record_outcome`
lifecycle with an unchanged root model and exactly one bounded target/outcome.

## Node.js is missing or too old

The router requires Node.js 24.15.0 or newer. Check both the interactive shell
and the runtime visible to Codex:

```bash
node --version
```

The installer writes its qualifying Node executable as an absolute MCP and Hook
command, so starting the launcher does not depend on Desktop's reduced `PATH`.
After the launcher starts, it searches `ADAPTIVE_ROUTER_NODE`, `PATH`, common
Node managers, and standard Windows/macOS/Linux locations. Set
`ADAPTIVE_ROUTER_NODE` to an absolute qualifying executable only when Codex
cannot discover the intended runtime. The router never runs under an older Node
release.

## PowerShell cannot run `install.ps1`

The supported installation path uses the reviewed repository wrapper so the
portable launch placeholders are materialized after native Codex registration.
If a reviewed local copy of `install.ps1` downloaded as an archive is blocked,
inspect it first and remove only that file's download mark:

```powershell
Unblock-File .\install.ps1
.\install.ps1
```

Avoid changing machine-wide execution policy solely for this plugin.

The wrapper prefers `codex.exe` or `codex.cmd`. A PowerShell-only shim without a
matching executable or command shim is rejected with exit code `2`.

## Legacy `adaptive-local` installation detected

Interactive wrappers ask before migrating the old installation. Non-interactive
mode makes no changes and prints these exact cleanup commands:

```bash
codex plugin remove adaptive-model-router@adaptive-local
codex plugin marketplace remove adaptive-local
```

Removing the old installation does not import its learning history. Supported
settings and an approved policy can be imported later with the explicitly
confirmed developer CLI described in [Tool reference](TOOLS.md#developer-cli).

## Routing returns `continue`

Inspect `reasonCodes`:

- `TRIVIAL_CONTINUE` or `NO_WORK_PRODUCT`: the stage was intentionally kept in
  the root task.
- `HOST_DELEGATION_UNAVAILABLE`: the current direct `spawn_agent` surface is
  unavailable. Do not infer this from an empty `list_agents` result. If this
  task already completed a direct Router child, the claim must be tied to an
  actual no-child tooling rejection.
- `ROOT_LOCAL_RETRY`: a failed root-local `continue` stage was routed again;
  this does not represent or increment subagent effort escalation.
- `CATALOG_UNAVAILABLE`: no usable visible known-model catalog was available;
  the router failed open to the root task.
- `ROUTER_DISABLED`: routing is disabled at an active scope.
- `HOST_MODEL_INTENT_PENDING`: the host model slug changed and the task is
  waiting for an explicit manual-versus-automatic decision. The current request
  continues on the root model.
- `MANUAL_ROOT_SELECTED`: this task was explicitly placed in root-only manual
  mode.
- `STORAGE_UNAVAILABLE`: local state failed and routing failed open.

Do not invent a model target after a fail-open result. Diagnose the catalog,
host capability, settings, or local storage first.

## A `delegate` route is described as blocked by a no-subagent policy

This is an orchestration-contract failure when the host policy only forbids
unrequested proactive subagents but explicitly permits delegation requested by
an applicable skill. Adaptive Model Router's returned `delegate` action is that
explicit skill authorization and must create exactly one bounded subagent. It
is not a recommendation. Do not ask the user to authorize it again, claim a
blanket prohibition, or silently continue the delegated stage in the root.

First confirm that the `route_stage` input truthfully declared current bounded
subagent capability and that the returned target is in that declaration. If the
host tool actually rejects the target before startup, record `failed/tooling`
and follow the single automatic retry described below. If no launch was even
attempted, do not call that a host rejection; upgrade to a runtime whose skill,
automatic Hook context, and optional managed AGENTS block contain the explicit
delegate-authorization contract, then start a fresh task so the changed Hook
and skill are loaded.

## Luna is recommended but the host rejects it as a subagent

Upgrade to v0.3.1 or newer. v0.3.0 could mistake a root-visible Luna entry for
bounded-subagent capability. The router now accepts the current host's strict
`hostCapabilities.delegation` and otherwise conservatively permits only Sol
and Terra.

Luna may still be valid for the root task or the auxiliary classifier's
ephemeral app-server. Those facts do not make it a bounded target. With a
Sol/Terra-only delegate catalog, automatic Luna preferences fall back to Terra;
an explicit Luna override returns `ask_user`.

If a model declared by the host is nevertheless rejected at startup, retry only
when the Agent result explicitly proves that no child was created. A generic
error is ambiguous: continue in the root, do not launch another Agent, and
inspect the current host tool contract instead of retrying indefinitely.

## Routing returns `busy`

`busy` means this task already has one unresolved Router-managed delegation.
Do not create another Agent, do not record an outcome for the non-persisted
`busy.routeId`, and do not loop on `route_stage`. Use `router: status` to inspect
the reported `blockingRouteId`. The gate becomes available only after the
matching `PostToolUse`, a child terminal observation (`SubagentStop` or explicit
no-child proof), and the delegated route's outcome are all recorded.

On direct multi-agent v2 hosts, `PostToolUse` can arrive first with only the
exact returned task name. This is a valid pending handshake, not proof of an
unknown child: the gate remains occupied until the trusted `SubagentStart`
claims that ticket and supplies the agent identity, then `SubagentStop` records
the measured transcript. A conflicting task name or agent identity still marks
the attempt ambiguous and never releases it automatically.

If status reports `ambiguous: true`, keep working root-only. Do not clear the
gate automatically because the child lifecycle is not proven. A genuinely new
task has a new context and can route independently; `clear_project_data` is a
separate destructive last resort that also removes that project's learning
history.

## No model target or history is visible

Send `router: status` or `路由器：状态`, then `router: history 10` or
`路由器：历史 10`. If status reports no route, either `route_stage` has not been
called in this task or the caller used a different `contextId`. The Stop hook,
status, history, route, and outcome lifecycle must use the same host task/session
identifier.

When the trusted hook supplies a valid model slug, status can display that
observed root-task model. Otherwise it displays `host-managed`. The router
cannot read root reasoning effort; inspect the Codex model selector for that.
The selector always describes the root task and never changes to show a bounded
subagent. History rows separately label their root-model snapshot and bounded
stage target. See [Routing triggers and history](ROUTING.md) for the exact
distinction and score thresholds.

Routine conversation notices intentionally omit route IDs. They remain in
explicit status/history reports and internal route/outcome records; missing
IDs in a normal notice do not mean that tracing was disabled. A delegated
target omits `service_tier` when no direct, child-scoped host
evidence is available. Do not interpret that omission as Standard mode or infer Fast
from the parent setting or a model's supported tiers. A requested tier alone
does not verify the tier actually used to serve the request.

## A model change reminder keeps appearing

A changed host model creates a pending intent event. The current and later
unconfirmed requests continue on the new root model without delegation. Reply
with one of these standalone control commands:

```text
router: manual
router: auto session
```

The first keeps this task root-only. The second keeps automatic routing and
restores delegation from the next substantive stage. Restoring the original
model slug cancels the pending event; another model change supersedes the old
event. `resolve_host_model_intent` is the strict MCP equivalent when a caller
already has the displayed change ID.

The first model observed in a task only establishes a baseline and never asks a
question. The hook sees a model slug but not reasoning effort, so changing only
Sol Max to Sol High is not detectable. Send `router: manual` explicitly when an
effort-only change is intended to make the current task root-only.

## Routing returns `ask_user`

Common reasons are `EXPLICIT_TARGET_UNAVAILABLE`,
`MONOTONIC_ESCALATION_UNAVAILABLE`, and `ESCALATION_LIMIT_REACHED`. The router
does not silently replace an unavailable explicit model or effort. Obtain a new
user choice, or fix model availability, before retrying.

## Classifier timed out or the circuit is open

The classifier has one eight-second total deadline. Three consecutive failures
open a ten-minute circuit breaker. Routing continues with the deterministic
local policy.

The classifier must reuse the host's authenticated App Server store while
setting `thread/start.ephemeral=true`. If initialization repeatedly times out,
verify that the runtime is not redirecting `CODEX_SQLITE_HOME` to a new empty
directory. An ephemeral thread prevents task persistence; an empty SQLite home
removes the login/session state required to initialize the current host.

For zero classifier app-server calls, configure `classifierMode` as
`local-only` or `disabled`, or set:

```bash
ADAPTIVE_ROUTER_LOCAL_ONLY=1
```

## Hook feedback says a delegated route was not launched

The current Stop hook blocks the first stop when `route_stage` returned
`delegate` but its ticket was never consumed. Use that same route's exact
carrier to call direct `spawn_agent`; do not call `route_stage` again and do not
write an outcome first. The guarded Stop re-entry is allowed only to avoid an
infinite hook loop. If its ticket is still unconsumed, that re-entry marks the
lifecycle ambiguous and retains the gate and reservation. It never invents an
outcome or `no_child` proof, archives the attempt, or launches a replacement.
If a current runtime instead asks for outcome bookkeeping
without requiring dispatch, verify the installed runtime and Hook definitions.

When opening existing v5 storage, the current runtime also quarantines the one
legacy state that is provably invalid under this contract: an unconsumed ticket
that an older runtime already paired with an outcome. It retains the route and
outcome audit rows, marks the attempt ambiguous and terminal, clears the
one-shot carrier material, and does not reinterpret it as child execution.

## Outcome is rejected

`record_outcome` accepts delegated route IDs only, and the first write requires
the matching dispatch handshake to have consumed the route ticket. Use the same
`contextId` as the route, the exact verification-gate enum, an allowed status,
and consistent failure fields. `retryBreakdown` must contain all four
failure-type counters and sum exactly to `retries`. Repeating an identical
outcome is safe; changing an already recorded final outcome is rejected.

## Data cleanup

Uninstalling leaves project learning data intact. To delete data, call
`clear_project_data` from the project with exact confirmation
`CLEAR_PROJECT_DATA`. It removes only that project's rows and preserves the
local HMAC salt and other projects.

For security issues, follow [SECURITY.md](../SECURITY.md) instead of opening a
public troubleshooting issue with sensitive details.
