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

2. Refresh and reinstall:

   ```bash
   codex plugin marketplace upgrade adaptive-model-router
   codex plugin add adaptive-model-router@adaptive-model-router
   ```

3. Start a new Codex task. If the ChatGPT desktop app still shows stale plugin
   state, restart the app and open another new task.

If a marketplace named `adaptive-model-router` points to a different source or
ref, the wrapper stops rather than replacing it. Inspect the marketplace list
and remove it only after confirming it belongs to this plugin.

Release maintainers can pass an explicit reviewed candidate ref with
`./install.sh --ref=<ref>` or `.\install.ps1 -Ref <ref>`. Use the same ref for
install, upgrade, and uninstall. Ordinary users should omit this option and
remain on the default protected `stable` branch.

## Hooks are installed but do not run

Plugin installation does not automatically trust command hooks. In Codex, open
`/hooks`, review the installed definitions, and trust the `UserPromptSubmit` and
`Stop` handlers. Trust is tied to the definition hash, so changed hooks require
review again.

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
Hook trust is hash-specific after an upgrade. Simple questions and stages with
no work product may still continue in the root task by design.

## Node.js is missing or too old

The router requires Node.js 24.15.0 or newer. Check both the interactive shell
and the runtime visible to Codex:

```bash
node --version
```

The launcher searches `ADAPTIVE_ROUTER_NODE`, `PATH`, common Node managers, and
standard Windows/macOS/Linux locations. Set `ADAPTIVE_ROUTER_NODE` to an
absolute qualifying executable only when Codex cannot discover the intended
runtime. The router never runs under an older Node release.

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
