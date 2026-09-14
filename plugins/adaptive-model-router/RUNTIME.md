# Runtime protocol v2 commands

This package uses explicit publication. Its legacy `manage-install.mjs install`,
`upgrade`, and `repair` commands refuse; they are not v2 installation commands.
The repository runbook is `docs/RUNTIME-UPGRADE-ISOLATION-IMPLEMENTATION.zh-CN.md`.
First native installation remains a separate cold host operation.

All admin options use `--name=value`; no default data home is selected.

| Action | Required options | Effect |
| --- | --- | --- |
| prepare-shell | source, shell-root, home | Create a new stable shell and dedicated parent marketplace; no database or native registration |
| prepare | source, candidates; shell-root for normal source releases | Create an isolated complete candidate; inherit the exact materialized entry after checking the original template hashes |
| bootstrap | candidate, shell-root, home; legacy-runtime for existing data | Cold first enrollment, same shared database and preserved legacy responsibilities |
| publish | candidate, home | Run exact A/B isolated compatibility qualification and update the new-binding default |
| references | digest, home | Read references through a private stable database snapshot; never initialize legacy state |
| archive / restore | digest, home | Move a complete package between deterministic retained paths; never discard bytes |
| capture-host-entries | anchor, archive | Preserve all files in the installed anchor's versions parent before native marketplace removal |
| restore-host-entries | archive, versions-root | Cold, exact, non-overwriting restoration of every retained historical path; preserve the new cache generation |
| restore-host-entry | digest, path, home | Cold restoration of one exactly registered retained host path |

For a normal source edit after the first stable enrollment:

```bash
node /absolute/stable-entry/plugin/scripts/runtime-admin.mjs prepare \
  --source=/absolute/checkout/plugins/adaptive-model-router \
  --shell-root=/absolute/stable-entry/plugin \
  --candidates=/absolute/offline-candidates
node /absolute/stable-entry/plugin/scripts/runtime-admin.mjs publish \
  --candidate=/absolute/offline-candidates/RETURNED_DIGEST \
  --home=/absolute/original-router-data
```

Only validated pure category branches in `inferCategory` are an open runtime
code boundary in this epoch. Other writer, Hook, adapter, and native entry
changes require a separately implemented compatibility transition. Matching
version numbers or a claimed pass cannot grant compatibility. Every regular
file stays covered by the full package digest. The semantic entrypoint mapping
and every selected entry's code are frozen too; redirecting service, Hook or
probe through another file is not an allowed release change.

Publication does not move in-flight tasks. Native completion, no unresolved
work, and verified candidate qualification are required for a v2 task migration.
Legacy tasks remain on the preserved v1 execution generation; original creation
versions are unknown. Both generations use the same policy, salt, outcomes,
deferred reservations and global limit of 10.

Native marketplace removal can delete historical cache paths. Capture all of
them before the first registration change and restore in the success **and**
failure paths while the host remains cold. Do not use native plugin add/remove
for ordinary runtime publication. Never replace the database with a snapshot
to roll a runtime back.

Explicit removal still uses `node scripts/manage-install.mjs uninstall` from
the source checkout, stable shell, or its native cache copy. The wrapper checks
the prepared shell's exact source and dedicated marketplace binding before
removal, and preserves shared data and unrelated configuration. Stop Router
processes and retain any still-needed historical entries before uninstalling.
