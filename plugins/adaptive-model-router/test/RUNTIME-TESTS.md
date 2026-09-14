# Runtime isolation regression contract

Run `npm test`, or `node scripts/test-isolated.mjs test/runtime-isolation.test.mjs`.
The wrapper gives every test process an explicit disposable Router home, plugin
data directory and Codex Home. Individual writer fixtures additionally assert
their temporary domain before opening a store. Never run the compatibility
verifier with an implicit environment; it now refuses before importing writers.

`installer.v1-archive.mjs`, `runtime-hot-upgrade.v1-archive.mjs`, and
`runtime-vault-recovery.v1-archive.mjs` retain the previous tests as historical
evidence. Their v1 predicates (sibling discovery, automatic pointer promotion,
rewriting old entry snapshots, and repairing live caches) are intentionally not
the v2 contract and are excluded from the default test glob.

Still-valid behavior is covered by the current installer/runtime-isolation,
state-sharing, MCP, stdio, stage-closure, path and diagnostics tests: immutable
entry preparation, explicit bootstrap/publication/default rollback, failure
before hot installer mutation, protected and crash-recoverable archival,
directory identity, package integrity, owned uninstall preservation, real stdio
delivery, Hook/MCP shared context, and retained stage requirements/results.
Archival is not a claim that every old installer test passed or is replaced by
an equivalent v2 native installation test. An opt-in test executes native local
marketplace replacement and all historical cache-path restoration in an explicit
temporary CODEX_HOME. Real-user first installation, logged-in lifecycle, and
Hook trust remain separate acceptance steps. The controlled macOS installation
and retained-task delegation passed on 2026-09-14; native Windows logged-in
acceptance is still pending. See the repository's installation evidence.

The exact installed v1 interoperability test requires
`ADAPTIVE_ROUTER_LEGACY_FIXTURE` pointing to an isolated, complete copy of the
reviewed installed package. The baseline full digest is pinned in the cold
compatibility adapter. No live installed configuration is executed by that test.

Set `ADAPTIVE_ROUTER_NATIVE_CLI` to the actual native CLI executable to also run
the isolated registration test. It requires the same exact legacy fixture and
does not load the user's installed plugin or data. The CLI source-publication
test starts from ordinary repository source and supplies `--shell-root`; it does
not manufacture B by copying a hand-edited stable shell.

Independent review regressions reject redirected Hook/service/probe mappings
and changed probe code before publication, including the cold legacy bridge.
The uninstall tests cover source, stable-shell and cache callers, reject foreign
source ownership or a marketplace containing another plugin, and retain data.
The opt-in native CLI registration test also removes its temporary v2 plugin
through the real uninstall wrapper; it never operates on the user's home.
