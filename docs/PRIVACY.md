# Privacy

Adaptive Model Router is local-first. When Codex launches the plugin, its routing database is stored in the plugin-specific writable `PLUGIN_DATA` directory. Direct CLI use falls back to `adaptive-model-router-v2/router.sqlite3` under the user's Codex home. `ADAPTIVE_ROUTER_HOME` remains an explicit test and operations override.

## Stored locally

The SQLite database stores:

- random route, proposal, and immutable policy revision IDs;
- HMAC project and context identifiers;
- selected model family/model/effort, category, reason codes, verification gate, and escalation count;
- strict outcome status and aggregate retry/correction fields;
- scoped settings, overrides, evidence cursors, and classifier circuit-breaker counters.

The database does **not** store prompts, source code, assistant messages, transcripts, environment variables, secrets, or original project paths. The project HMAC uses a random salt generated locally. Git worktrees share their Git common directory identity; submodules remain separate.

WAL sidecar files are part of the same SQLite database and follow the same data minimization rules.

## Auxiliary classifier

The classifier is used only for substantive borderline tasks. At most 2,000 characters are sent in total, consisting of:

- a redacted task summary;
- a short redacted phase;
- fixed boolean signals.

Code blocks, inline code, POSIX and Windows absolute paths, environment assignments, and common secret formats are removed. Raw evidence objects, source attachments, and arbitrary files are never sent. The classifier must return a closed structured schema with enumerated reason codes; free text cannot become a routing instruction.

Each classifier app-server uses an ephemeral thread and a unique temporary SQLite home. The temporary home is removed when the classifier process exits.

Set `classifierMode` to `local-only` or `disabled`, or set `ADAPTIVE_ROUTER_LOCAL_ONLY=1`, for zero classifier app-server calls.

## MCP and hook output

Status and diagnostic tools are scoped to the current project/context and return truncated opaque identifiers. They cannot enumerate other projects or sessions. Hook errors are generic and do not include the prompt, last assistant message, transcript path, working directory, or secrets.

`get_route_history` and the `router: history` / `路由器：历史` reports use only
the already-minimized route and outcome rows. They expose route timestamps,
model/effort targets, transitions, reason codes, and outcomes for the current
project/context; they do not add a transcript log or store display text.

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

`clear_project_data` requires the exact confirmation `CLEAR_PROJECT_DATA` and removes only the current project's rows. Other projects and the local HMAC salt remain intact. Uninstalling the plugin does not silently delete learning data.

See [Tool reference](TOOLS.md) for the deletion contract and
[Troubleshooting](TROUBLESHOOTING.md) before collecting diagnostic information
for a report.
