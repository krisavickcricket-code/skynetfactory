# SkyNetFactory Contract Authoring Standard

A module contract is **not a feature request** — it is a **reusable capability specification**.

## Core Principle

Every module contract must describe a **single, clear, reusable capability** that can be:
- Verified through deterministic acceptance gates
- Composed with other modules
- Understood and used by AI agents via the sidecar

## Required Fields

Every module contract must include all required fields defined in `MODULE_CONTRACT_SCHEMA.json`.

### Key Fields Explained

- **module_id**: Domain-qualified identifier in `<domain>.<capability_name>` format (e.g., `storage.integrity_verifier`). No spaces, no version numbers.
- **purpose**: At least 20 characters. Clear statement of what this module does and why it exists.
- **reuse_scope**: List of contexts where the module could be reused (at least 1, each at least 5 chars).
- **api**: Defines the module's API surface (HTTP, CLI, library, gRPC, or WebSocket).
- **sidecar_specification**: The FULL sidecar content - this IS the sidecar, not just requirements.
- **acceptance_gates**: List of gate names that must ALL pass (AND logic).
- **forbidden_behaviors**: What must NOT happen, with a detection method for each.
- **network_requirements**: If omitted, module is assumed to need NO network access.

## Granularity Rules

1. One clear reusable capability per module
2. API or CLI boundary required
3. Tests required
4. Sidecar required
5. Docker/VM-style test required
6. Dependencies must be declared as contracts
7. Failure modes must be documented
8. Network requirements must be declared
9. Forbidden behaviors must have detectable enforcement methods

## Network Requirements

**Default**: If `network_requirements` is not specified, the module requires NO network access.

If your module needs network access:
```json
{
  "network_requirements": {
    "requires_network": true,
    "allowed_hosts": [
      { "host": "api.github.com", "port": 443, "protocol": "https", "purpose": "Fetch repository metadata" }
    ],
    "allow_localhost": true
  }
}
```

## Forbidden Behaviors

Each forbidden behavior must have a `detection_method`:
- `write_scope_check` — validates files written are within scope
- `network_egress_check` — validates network calls match declared hosts
- `filesystem_mutation_diff` — git diff to detect undeclared mutations
- `static_analysis` — run linter with specified rules
- `runtime_sandbox_policy` — Docker sandbox enforcement
- `manual_review` — flag for human review (non-blocking: warn only)

## Sidecar Specification

The `sidecar_specification` contains the FULL sidecar content. The worker may refine it but must preserve all required fields. Include:
- `purpose` — what the sidecar describes
- `agent_usage.when_to_use` / `when_not_to_use` — guidance for consuming agents
- `common_calls` — how to call this module (at least 1)
- `failure_modes` — what can go wrong (at least 1)
- `composition_tags` — tags for discovery (at least 1)

## Validation

All contracts are validated against `MODULE_CONTRACT_SCHEMA.json` before entering the pipeline.
Contracts that fail validation are moved to the `rejected/` directory with a reason.