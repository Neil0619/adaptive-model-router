# Privacy

Adaptive Model Router is local-first. When Codex launches the plugin, its routing database is stored in the plugin-specific writable `PLUGIN_DATA` directory. Direct CLI use falls back to `adaptive-model-router-v2/router.sqlite3` under the user's Codex home. `ADAPTIVE_ROUTER_HOME` remains an explicit test and operations override.

## Stored locally

The SQLite database stores:

- random route, proposal, and immutable policy revision IDs;
- HMAC project and context identifiers;
- selected model family/model/effort, category, reason codes, verification gate, and escalation count;
- strict outcome status and aggregate retry/correction fields;
- strict per-failure retry counts;
- scoped settings, overrides, evidence cursors, and classifier circuit-breaker counters;
- immutable scoring-profile definitions and prompt-free score snapshots
  containing numeric scores, boolean signals, enum targets, policy/classifier
  adjustments, eligibility reasons, and opaque profile IDs;
- redacted learning events for profile re-anchors, proposal rebases, and hard
  safety rollbacks;
- the global automatic-routing opt-in and the current task mode;
- validated hook-observed root-model slugs and model-change event state, including
  opaque change IDs and whether an event is pending, resolved, cancelled, or
  superseded.

Per-call `hostCapabilities` are validated in memory and are not persisted.
They contain only bounded model slugs and effort enums, never prompts, source,
paths, or environment values.

The database does **not** store prompts, source code, assistant messages,
transcripts, environment variables, secrets, original project paths, or root
reasoning effort. Root-model values must pass a short allowlisted slug format
before storage; path/URI forms and common secret-token shapes are rejected.
Missing or invalid hook values are treated as host-managed and are not
persisted. The project HMAC uses a random salt generated locally. Git
worktrees share their Git common directory identity; submodules remain separate.

WAL sidecar files are part of the same SQLite database and follow the same data minimization rules.

## Auxiliary classifier

The classifier is used only for substantive borderline tasks. At most 2,000 characters are sent in total, consisting of:

- a redacted task summary;
- a short redacted phase;
- fixed boolean signals.

Code blocks, inline code, POSIX and Windows absolute paths, environment assignments, and common secret formats are removed. Raw evidence objects, source attachments, and arbitrary files are never sent. The classifier must return a closed structured schema with enumerated reason codes; free text cannot become a routing instruction.

Each classifier app-server uses an ephemeral thread and a unique temporary SQLite home. The temporary home is removed when the classifier process exits.
Its classifier-only model catalog comes from that app-server's `model/list`;
the catalog is not stored and is never treated as bounded-subagent capability.

Set `classifierMode` to `local-only` or `disabled`, or set `ADAPTIVE_ROUTER_LOCAL_ONLY=1`, for zero classifier app-server calls.

## MCP and hook output

Status and diagnostic tools are scoped to the current project/context and return truncated opaque identifiers. They cannot enumerate other projects or sessions. Hook errors are generic and do not include the prompt, last assistant message, transcript path, working directory, or secrets.

When global automatic routing is enabled, `UserPromptSubmit` emits only a fixed
model-visible routing instruction plus minimized root-model state. It does not
copy the user's task text. A pending model-intent reminder contains validated
model slugs and an opaque change ID, never the prompt or reasoning effort.

`get_route_history` and the `router: history` / `路由器：历史` reports use only
the already-minimized route and outcome rows. They expose route timestamps,
model/effort targets, transitions, reason codes, and outcomes for the current
project/context. Each history row distinguishes the hook-observed root-model
snapshot from the bounded-stage target; it does not add a transcript log or
store display text.

`get_learning_status` is current-project only. It reports scoring-profile
versions, approved category offsets, aggregate eligibility/exclusion counts,
proposal statistics, and fixed-enum learning events. `shadow_route_stage`
returns numeric/enum scoring output and does not create a route, outcome,
proposal, or cursor. Neither interface returns prompts, evidence payloads,
source, paths, or environment values.

The runtime launcher checks only Node executable versions from the current process, `ADAPTIVE_ROUTER_NODE`, `PATH`, common version-manager directories, and standard install locations. Candidate paths and versions are not stored, sent to a model, or included in errors.

## Legacy data

Data under the v0.1 legacy directory is never used for v0.2 learning
automatically. Diagnostics report only whether legacy state is present. An
explicit confirmed source-tree CLI import can copy supported settings and an
already-approved policy:

```bash
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs import-legacy --confirm IMPORT_LEGACY_SETTINGS_POLICY --context PROJECT_CONTEXT
```

Historical records remain archived in place and are counted only; they are
never added to the new learning window. The import is idempotent for a project.
Run the command with the intended project as the current working directory,
because project identity is derived from that directory.

## Deletion

`clear_project_data` requires the exact confirmation `CLEAR_PROJECT_DATA` and
removes only the current project's routes, outcomes, learning state, task-mode
state, scoring profiles/snapshots, and root-model change events. Other projects, the global automatic-routing
preference, and the local HMAC salt remain intact. Uninstalling the plugin does
not silently delete learning data.

See [Tool reference](TOOLS.md) for the deletion contract and
[Troubleshooting](TROUBLESHOOTING.md) before collecting diagnostic information
for a report.
