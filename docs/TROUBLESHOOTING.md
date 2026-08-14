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
   re-registration. Codex may resolve later `mcp list` queries to the staged
   sibling; this does not alter an existing task's fixed tool inventory. If it
   reports `HOST_RELOAD_REQUIRED`, fully exit
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

   For already-loaded bare Hook commands, the installer must also print the
   owned Desktop shim path and prove that exact shim under Desktop's reduced
   `PATH`. An unresolved platform location, an existing unowned shim, or a
   failed probe is a failed continuity repair. Do not interpret a skipped shim
   as successful in-place recovery.

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

4. After trusting the current Hooks, verify real task exposure with
   `./install.sh upgrade --verify-task-tools --non-interactive` or
   `.\install.ps1 -Action Upgrade -VerifyTaskTools -NonInteractive`. This uses
   one disposable Codex CLI task and fails unless `diagnose_router` and
   `route_stage` both complete. Without this flag, installation verifies MCP
   registration and direct tool discovery. Neither check proves that an
   already-created Desktop task retained its fixed tool inventory.

If a marketplace named `adaptive-model-router` points to a different source or
ref, the wrapper stops rather than replacing it. Inspect the marketplace list
and remove it only after confirming it belongs to this plugin.

Release maintainers can pass an explicit reviewed candidate ref with
`./install.sh --ref=<ref>` or `.\install.ps1 -Ref <ref>`. Use the same ref for
install, upgrade, and uninstall. Ordinary users should omit this option and
remain on the default protected `stable` branch.

## Hooks are installed but do not run

Plugin installation does not automatically trust command hooks. In Codex, open
`/hooks`, review the installed definitions, and trust the `SubagentStart`,
`UserPromptSubmit`, and `Stop` handlers. Trust is tied to the definition hash,
so changed hooks require review again.

Do not use `--dangerously-bypass-hook-trust` for normal installation or smoke
testing. Also check that hooks have not been disabled by local or managed Codex
configuration.

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
candidate, review all three changed hook definitions, and start a fresh task.
In the fixed version, `SubagentStart` and subagent-marked prompt hooks tell the
child to execute only its assigned scope. The child must not call
`route_stage`, change model-intent state, or own `record_outcome`; the root
task verifies and records the outcome.

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

Release acceptance requires more than `--verify-task-tools`: keep one real
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

The primary installation path uses native `codex plugin` commands and does not
require the wrapper. If a reviewed local copy of `install.ps1` downloaded as an
archive is blocked, inspect it first and remove only that file's download mark:

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
- `HOST_DELEGATION_UNAVAILABLE`: the current host cannot create the requested
  bounded subagent.
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

If a model declared by the host is nevertheless rejected at startup, record
the route as `failed/tooling` and reroute once with its `previousRouteId`.
After a second rejection, continue in the root and inspect the current host
tool contract instead of retrying indefinitely.

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

For zero classifier app-server calls, configure `classifierMode` as
`local-only` or `disabled`, or set:

```bash
ADAPTIVE_ROUTER_LOCAL_ONLY=1
```

## Hook feedback asks for `record_outcome`

Updated v0.4 runtimes do not block task completion solely because a delegated
route lacks an outcome. The Stop hook records `unknown`, excludes that result
from learning, and lets the user-facing reply finish. If Codex instead inserts a
`Hook feedback` continuation asking for `record_outcome`, the task is running an
older plugin runtime. Upgrade the configured marketplace, reinstall the plugin,
and start a fresh task when the Hook definition changed.

## Outcome is rejected

`record_outcome` accepts delegated route IDs only. Use the same `contextId` as
the route, the exact verification-gate enum, an allowed status, and consistent
failure fields. `retryBreakdown` must contain all four failure-type counters and
sum exactly to `retries`. Repeating an identical outcome is safe; changing an
already recorded final outcome is rejected.

## Data cleanup

Uninstalling leaves project learning data intact. To delete data, call
`clear_project_data` from the project with exact confirmation
`CLEAR_PROJECT_DATA`. It removes only that project's rows and preserves the
local HMAC salt and other projects.

For security issues, follow [SECURITY.md](../SECURITY.md) instead of opening a
public troubleshooting issue with sensitive details.
