# SkyNetFactory Decisions Log

## Decision 001 - 2026-05-07
**Decision**: Build separate Fastify API server instead of extending AgentSwarm API.
**Reason**: AgentSwarm uses custom Node HTTP server with API key auth and different route patterns. SkyNetFactory needs localhost-only auth model and different endpoints. Per Phase 1 reuse audit, classify as "build_new" — lower risk than coupling to AgentSwarm's internal router.
**Authority**: reuse_policy.graceful_degradation.api_server_not_extendable

## Decision 002 - 2026-05-07
**Decision**: AgentSwarm websocket unavailable — use polling fallback with supervisor WebSocket server for UI.
**Reason**: AgentSwarm doesn't have native WebSocket push. Supervisor polls AgentSwarm task status and pushes to UI clients via its own WebSocket.
**Authority**: agent_swarm_integration.graceful_degradation.websocket_unavailable

## Decision 003 - 2026-05-07
**Decision**: Use file-based contract state tracking (contract_state.json files) instead of AgentSwarm SQLite database.
**Reason**: AgentSwarm's schema is tied to its task/agent model. SkyNetFactory's lifecycle states don't map cleanly to AgentSwarm task states. File-per-contract allows atomic moves between state directories.
**Authority**: contract_lifecycle.state_tracking.mechanism

## Decision 004 - 2026-05-07
**Decision**: Implement own task queue as thin layer over AgentSwarm task API with graceful degradation.
**Reason**: AgentSwarm task submission API exists but format differs from SkyNetFactory task packets. Translation layer needed. If AgentSwarm unavailable, supervisor handles scheduling directly.
**Authority**: agent_swarm_integration.graceful_degradation.task_queue_incompatible