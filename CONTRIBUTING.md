# Contributing

Thank you for helping improve Adaptive Model Router.

## Development setup

Install Node.js 24.15.0 or newer, Git, and a current Codex CLI. The runtime intentionally has no third-party dependencies.

```bash
cd plugins/adaptive-model-router
npm test
npm run validate
npm run eval
```

Before submitting a change:

1. Keep the root-task/bounded-subagent product boundary explicit.
2. Add regression coverage for contract, concurrency, privacy, or cross-platform behavior you change.
3. Keep every MCP object schema closed with `additionalProperties: false`.
4. Never add prompts, source, raw paths, environment variables, or secrets to storage or diagnostics.
5. Run tests, validation, and the bilingual routing benchmark on Node 24.15 or newer.

Use small focused commits and explain behavior changes in `CHANGELOG.md`. Do not commit local SQLite databases, logs, credentials, or Codex caches.

## Release process

`v0.2.0` is released from a reviewed commit. CI must pass on Ubuntu, macOS, and Windows. A maintainer runs logged-in macOS and Windows 11 end-to-end smoke tests, creates the signed tag, lets the release workflow generate the source archive, SBOM, checksums, and provenance, and only then advances the protected `stable` branch.
