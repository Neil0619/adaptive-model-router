---
name: adaptive-model-router
description: Choose whether a substantive Codex task stage should continue locally, ask the user, or run as one bounded subagent with a specific available model and reasoning effort. Use at task-stage boundaries, after verification failures, or when the user explicitly controls adaptive routing.
---

# Adaptive Model Router

Use the router at a meaningful stage boundary, not before every message. It does not change the root task model. It can recommend one bounded subagent model and reasoning effort while the root remains the orchestrator.

## Route a stage

1. Call `route_stage` with:
   - a concise stage `goal`;
   - the current `phase`;
   - strictly factual boolean/integer `evidence`;
   - a stable task/thread identifier as `contextId`;
   - `previousRouteId` only when continuing or retrying a route returned earlier;
   - an `override` only when the user explicitly requested a model or effort for this call.
2. Follow the returned `action`:
   - `continue`: keep working in the current root task. Do not create a subagent.
   - `ask_user`: explain the reason code and obtain the missing decision.
   - `delegate`: create one bounded subagent using exactly `target.model` and `target.effort` if the host supports those subagent parameters.
3. When delegation is unavailable in the current host, fail open by continuing with the current model. Do not claim that the root task model changed.
4. Keep the delegated scope concrete and bounded. The root owns orchestration, integration, user communication, and verification. Never create overlapping writers.
5. Run the returned `verificationGate` at the root. Then call `record_outcome` once with the route ID and the exact final outcome schema.

The supported host parameters are the model and reasoning-effort fields exposed by the subagent tool. Do not invent `agentType`, `agent_type`, or other unsupported parameters.

## Failures and escalation

On a verification failure, route the next attempt with the prior `routeId`, `verificationFailed: true`, and an enumerated `failureType`. Reasoning failures escalate monotonically. Environment and missing-information failures do not justify a stronger model. After the automatic limit, ask the user instead of silently changing targets.

## Controls and learning

Only prompts beginning exactly with `router:` or `路由器：` are control commands. Quoted text, code blocks, negations, and ordinary discussion do not change router state.

Learning is project-local. A proposal never changes policy until the user explicitly calls `approve_policy_proposal`. Rejection advances the evidence window; rollback walks backward through immutable revisions. Do not approve, reject, roll back, import legacy settings, or clear project data without an explicit user instruction.

The auxiliary classifier receives only a redacted short summary, phase, and boolean signals. If it is disabled, local-only, timed out, or circuit-broken, use the deterministic route.
