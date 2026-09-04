# Security Policy

## Supported versions

Security fixes are provided for the latest `0.4.x` release while the project is pre-1.0.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for `Neil0619/adaptive-model-router`. Do not open a public issue containing exploit details, secrets, private prompts, or project paths.

Include the affected version, operating system, Codex surface, minimal reproduction, and impact. You should receive an acknowledgement within seven days. No SLA is promised for this community project, but confirmed issues will be triaged before public disclosure.

## Trust boundary

Plugin hooks are local commands and Codex requires the user to review and trust
their exact definitions. Use `/hooks` to inspect the plugin-bundled
`SessionStart(source=compact)`, `SubagentStart`, `SubagentStop`,
`PreToolUse(Agent)`, `PostToolUse(Agent)`, `UserPromptSubmit`, and `Stop`
handlers. Changed definitions require review again because trust is tied to the
current hook hash.

Do not use `--dangerously-bypass-hook-trust` for normal use or release smoke
testing. This project does not ask users to pipe a remote script into a shell;
the primary installation path uses native Codex marketplace commands. The
optional repository wrappers execute only after download and review.

The plugin MCP server auto-approves only the normal routing lifecycle and
read-only inspection allowlist so automatic routing also works on headless
Codex surfaces. Configuration, route overrides, policy approval or rejection,
rollback, rebase, scoring-profile re-anchoring, legacy import, and project-data
deletion remain approval-prompted. Server-side confirmation requirements still
apply independently of the host approval mode.

Router diagnostics and public reports must not include prompts, source,
credentials, environment-variable values, SQLite files, or absolute project
paths. See [docs/PRIVACY.md](docs/PRIVACY.md) and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
