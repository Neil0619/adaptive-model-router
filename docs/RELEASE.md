# v0.2.0 release checklist

## Automated gate

- Ubuntu, macOS, and Windows pass on Node 24.15.0 and the latest Node 24 LTS.
- Unit, 50-process concurrency, privacy, hook, MCP, installer, and bilingual evaluation suites pass.
- Syntax, manifest, marketplace, plugin, and skill validation pass.
- CodeQL passes.

## Logged-in smoke gate

Run this once on macOS and once on native Windows 11 using a temporary test project:

For the first release only, bootstrap `stable` from the exact reviewed `main`
commit before this gate. This makes the documented installation command usable
without publishing a tag early. Do not add release-only changes to either branch
after the bootstrap; the release workflow will advance (or confirm) `stable` at
the tagged commit only after the artifacts exist.

1. Install from the candidate `stable` ref with the two documented native commands.
2. Review and trust both plugin hooks.
3. Start a new task and call `route_stage` for a substantive bounded stage.
4. Create the bounded subagent using exactly the returned model and effort.
5. Integrate the result, run the verification gate, and record a `passed` or `failed` outcome.
6. Confirm status/diagnostics expose no prompt or absolute path.
7. Exercise upgrade, uninstall, reinstall, and optional AGENTS patch removal.

Run the same sequence manually or through the non-blocking nightly workflow in WSL2. WSL2 is tracked independently and does not block an ordinary pull request.

## Publish

The current `Neil0619` GitHub credential must be refreshed before any remote operation:

```bash
gh auth login
gh auth status
```

Then confirm `main` and `stable` protections, create the signed `v0.2.0` tag, and push it. The release workflow reruns the full gate, creates the source archive, SPDX SBOM, SHA-256 checksums, and build provenance, publishes the GitHub release, and advances `stable` only after artifacts exist.

The `stable` protection must reject force pushes and deletion while allowing the
release workflow to make a normal fast-forward update. Verify that permission
before pushing the tag so the final workflow step cannot be blocked after the
GitHub Release has already been created.

Do not publish the npm package; `private: true` is a release invariant.
