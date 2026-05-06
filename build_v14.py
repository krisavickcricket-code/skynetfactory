import json

with open('skynetfactory_authority_contract_v1_3.json', 'r') as f:
    c = json.load(f)

# Update version
c['contract_version'] = '1.4.0'
c['updated_at'] = '2026-05-07T02:00:00.000000'

# ==============================
# 1. IMPLEMENTATION LANGUAGES
# ==============================
c['implementation_languages'] = {
    "supervisor": "typescript",
    "supervisor_runtime": "node",
    "supervisor_justification": "TypeScript gives type safety for the complex contract/adapter/gate logic, shares the Node ecosystem with the default module language, and can reuse AgentSwarm's likely Node-based API server directly. Fastify for the API server, tsx/ts-node for execution.",
    "worker_adapter": "typescript",
    "worker_adapter_runtime": "node",
    "worker_adapter_justification": "Runs alongside the supervisor in the same process or as a child process. Needs programmatic access to Ollama API, file system operations for write-scope enforcement, and command allowlist interception.",
    "gate_runner": "typescript",
    "gate_runner_runtime": "node",
    "gate_runner_justification": "Part of the supervisor. Needs to exec shell commands, parse JSON, diff file systems.",
    "electron_ui": "react_typescript",
    "electron_ui_justification": "Already specified in electron_ui.stack.",
    "rule": "All SkyNetFactory-specific new code is TypeScript/Node unless AgentSwarm reuse dictates otherwise. Python, Go, and Rust are supported as MODULE implementation languages — not as SkyNetFactory system implementation languages."
}

# Insert after meta section (before project_goal)
# Reorder keys: meta, implementation_languages, project_goal, ...
ordered = {}
for k, v in c.items():
    ordered[k] = v
    if k == 'meta':
        ordered['implementation_languages'] = c.get('implementation_languages', {})
c = ordered

# ==============================
# 2. HAPPY PATH FLOW
# ==============================
c['happy_path_flow'] = {
    "description": "The complete happy path sequence from contract submission to verified registration. Every component mentioned here must exist before this flow works end-to-end.",
    "steps": [
        {
            "step": 1,
            "actor": "operator_or_codex",
            "action": "Place module contract JSON in C:\\SkynetFactory\\module-contracts\\pending\\<module_id>.json",
            "side_effects": ["Supervisor file watcher detects new file"]
        },
        {
            "step": 2,
            "actor": "supervisor_contract_watcher",
            "action": "Detect new file in pending/. Validate contract against MODULE_CONTRACT_SCHEMA.json. Create contract_state.json alongside it.",
            "side_effects": ["contract_state.json created with current_state=pending, attempt_count=0, remediation_count=0"],
            "on_failure": "Move contract to rejected/ with reason 'contract_schema_invalid'. Log to decisions/."
        },
        {
            "step": 3,
            "actor": "supervisor_claim_manager",
            "action": "Check guard: no other contract for same module_id in {claimed, building, testing}. Acquire atomic lockfile. Move contract + state to claimed/.",
            "side_effects": ["Lockfile written to temp/claims/<module_id>.lock", "contract_state.json updated: current_state=claimed, lock_holder_worker_id set", "UI event: contract_state_changed"],
            "on_failure": "If guard fails: reject claim, leave in pending. If lock exists: wait for lock release."
        },
        {
            "step": 4,
            "actor": "supervisor_task_translator",
            "action": "Translate contract to AgentSwarm task. Derive write_scope from write_scope_derivation. Build task_packet with contract JSON + write_scope + production_module_path. Submit via submitTaskToAgentSwarm(task).",
            "side_effects": ["AgentSwarm task created and queued"],
            "on_failure": "If AgentSwarm API unreachable: revert to pending with log. Health check may already be warning."
        },
        {
            "step": 5,
            "actor": "supervisor_worktree_manager",
            "action": "Move contract + state to building/. Create git branch module/<module_id> if not exists. Create worktree if not exists. Scaffold module directory in worktree. Commit and tag 'build-start-1-<timestamp>'.",
            "side_effects": ["contract_state.json: current_state=building, attempt_count=1, build_start_tag set", "UI event: contract_state_changed"],
            "on_failure": "If worktree creation fails: move to remediation with reason."
        },
        {
            "step": 6,
            "actor": "agent_swarm_worker_scheduler",
            "action": "AgentSwarm dispatches task to available worker. Worker reads task_packet.json.",
            "note": "AgentSwarm handles this step. SkyNetFactory does not control worker assignment."
        },
        {
            "step": 7,
            "actor": "ollama_worker",
            "action": "Worker reads module contract from task_packet. Translates contract to LLM prompt (see contract_to_prompt_translation). Calls Ollama API at http://localhost:11434/api/chat with model, temperature=0.1, seed if supported. Receives generated code. Writes files to worktree within write_scope. Runs allowed commands to test. Writes worker_result.json to worktree root.",
            "side_effects": ["Code files written to C:\\SkynetFactory\\worktrees\\<module_id>", "worker_result.json written", "worker log entries"],
            "on_failure": "Worker timeout (1800000ms): supervisor moves to remediation. Command allowlist violation: block and log. Write scope violation: block and log."
        },
        {
            "step": 8,
            "actor": "supervisor_result_normalizer",
            "action": "AgentSwarm reports task completion. Supervisor calls normalizeAgentSwarmResult(taskId). Copy worker_result.json from worktree to log directory. Move contract + state to testing/.",
            "side_effects": ["contract_state.json: current_state=testing", "UI event: contract_state_changed, worker_completed"]
        },
        {
            "step": 9,
            "actor": "supervisor_gate_runner",
            "action": "Execute all gates listed in contract's acceptance_gates, in the order defined in acceptance_gate_engine.gates. Use test_commands_by_runtime for the module's declared runtime. Record each gate result. Write gate_result.json to worktree and evidence bundle path.",
            "side_effects": ["gate_result.json written", "evidence bundle assembled", "UI event: gate_result"],
            "on_gate_pass": "Proceed to step 10.",
            "on_gate_fail": "Proceed to step 9a."
        },
        {
            "step": "9a",
            "actor": "supervisor_gate_runner",
            "action": "GATE FAILURE PATH: Increment consecutive_failure_count in contract_state.json. If count < model_fallback_threshold (3): stay with same model. If count == 3: switch to next model in fallback chain. If count >= max_remediation_attempts: move to rejected. Otherwise: move to remediation.",
            "side_effects": ["Files preserved to logs/failed_attempts/", "Worktree rolled back to build-start tag", "contract_state.json: remediation_count incremented", "contract moved to remediation/"],
            "on_success_of_remediation": "Loop back to step 5 (re-enter building with incremented attempt_count)"
        },
        {
            "step": 10,
            "actor": "supervisor_registration_manager",
            "action": "ALL GATES PASS. Copy verified module from worktree to C:\\SkynetFactory\\production-modules\\<module_id>. Git tag 'verified-<version>-<timestamp>'. Write registry entry to C:\\SkynetFactory\\registry\\<module_id>.json. Rebuild registry index. Move contract + state to completed/.",
            "side_effects": ["Production module installed", "Registry entry written", "Registry index rebuilt", "contract_state.json: current_state=completed, consecutive_failure_count reset to 0", "UI event: contract_state_changed"]
        },
        {
            "step": 11,
            "actor": "supervisor_api_server",
            "action": "Push WebSocket event 'contract_state_changed' with module_id, to_state=completed. Push 'gate_result' with overall_result=pass. UI updates live.",
            "side_effects": ["UI shows completed module in pipeline and registry"]
        }
    ],
    "failure_path_summary": "Worker failure -> remediation -> rollback worktree -> retry (up to max_remediation_attempts). Gate failure -> same path. Consecutive failures -> model fallback at 3, circuit breaker at 5. Timeout on any state -> move to remediation or revert to pending."
}

# ==============================
# 3. CONTRACT-TO-PROMPT TRANSLATION
# ==============================
c['contract_to_prompt_translation'] = {
    "description": "How the module contract JSON becomes an effective Ollama prompt. This is the core translation that makes the whole system work.",
    "responsible_component": "supervisor_task_translator (builds task_packet), ollama_worker (executes prompt against Ollama API)",
    "prompt_template": {
        "structure": [
            "1. SYSTEM role definition",
            "2. Module contract as structured context",
            "3. Implementation requirements derived from contract fields",
            "4. Constraints, forbidden behaviors, and network policy",
            "5. Output structure requirements (module_output_required_structure)",
            "6. Sidecar template to fill out",
            "7. Reminders about allowed commands and write scope"
        ],
        "system_message": "You are a module implementer for SkyNetFactory. You receive a module contract and produce a complete, tested, production-ready implementation. Follow the contract exactly. Do not add features beyond the contract. Do not skip any required test or file.",
        "contract_context_section": "Provide the FULL module contract JSON as the primary context. The contract IS the specification. Every field in the contract is an implementation requirement.",
        "implementation_requirements_section": "Derive explicit instructions from contract fields: (1) api.endpoints -> implement these HTTP routes, (2) api.schemas -> request/response validation, (3) vm_test_requirements -> Dockerfile and docker-compose.test.yml, (4) forbidden_behaviors -> explicit DO NOT statements, (5) dependencies -> install and use these packages, (6) network_requirements -> if requires_network is false, NO network calls whatsoever.",
        "output_structure_section": "List all required_paths from module_output_required_structure for the module's language_variant. Provide the exact file tree the module must produce.",
        "sidecar_section": "Provide the sidecar_specification from the contract. Tell the LLM to produce module.sidecar.json following this specification, adding module_id and version from the contract.",
        "constraints_section": "Explicitly state: (1) write_scope boundaries, (2) allowed commands list, (3) forbidden patterns, (4) network restrictions from network_requirements, (5) temperature and seed will be set externally."
    },
    "context_window_strategy": {
        "description": "Module implementation may require generating thousands of lines of code. If the Ollama model's context window fills up, the output will be truncated.",
        "approach": "chunked_implementation_with_verification",
        "chunks": [
            {
                "chunk": 1,
                "focus": "scaffold_and_types",
                "prompt_addition": "First, create the project scaffold: package.json (or pyproject.toml, go.mod, Cargo.toml), directory structure, and type/interface definitions matching the contract's api.schemas. Do NOT implement function bodies yet."
            },
            {
                "chunk": 2,
                "focus": "implementation",
                "prompt_addition": "Now implement the module logic. Here is the current file state: [files from chunk 1]. Implement all route handlers, business logic, and error handling."
            },
            {
                "chunk": 3,
                "focus": "tests_and_docker",
                "prompt_addition": "Now add unit tests, contract tests, Dockerfile, docker-compose.test.yml, README.md, and sidecar JSON. Here is the current implementation: [files from chunk 2]."
            }
        ],
        "chunk_detection": "After each Ollama response, check if the output appears truncated (unfinished code blocks, missing closing braces, etc.). If truncated, re-prompt with the chunk context and ask to continue from where it left off.",
        "fallback_on_truncation": "If more than 3 continuation prompts are needed for a single chunk, log a warning and proceed with what was generated. The gate runner will catch missing pieces."
    }
}

# ==============================
# 4. AGENT SWARM GRACEFUL DEGRADATION
# ==============================
c['agent_swarm_integration']['graceful_degradation'] = {
    "description": "AgentSwarm's actual capabilities are unknown until Phase 1 inspection. The following graceful degradation paths apply when AgentSwarm features are unavailable.",
    "websocket_unavailable": {
        "detection": "Phase 1 reuse audit classifies AgentSwarm event system as build_new or websocket not found",
        "fallback": "Supervisor polls AgentSwarm task status at poll_interval_ms (8000ms default) instead of receiving push events. Functionally equivalent but higher latency for UI updates.",
        "impact": "UI updates delayed by up to poll_interval_ms. No functional loss."
    },
    "remediation_guidance_unsupported": {
        "detection": "requestRemediationGuidance function call returns error or timeout",
        "fallback": "Supervisor skips mid-task guidance. Worker proceeds with its own judgment. Remediation still works — just without supervisor input during task execution.",
        "impact": "Workers may make suboptimal choices during remediation retries. Acceptable for v1."
    },
    "api_server_not_extendable": {
        "detection": "AgentSwarm API server cannot be extended with SkyNetFactory routes (classified as build_new in reuse audit)",
        "fallback": "Supervisor runs its own Fastify API server on port 3013 (or another port if 3013 is taken by AgentSwarm). See supervisor_api_server.ownership.",
        "impact": "Two servers instead of one. UI connects to supervisor server. No functional loss."
    },
    "task_queue_incompatible": {
        "detection": "AgentSwarm task intake format cannot accept SkyNetFactory task packets",
        "fallback": "Supervisor implements a thin translation layer that wraps SkyNetFactory tasks in AgentSwarm-compatible format. If wrapping is impossible, supervisor implements its own minimal task queue.",
        "impact": "Additional translation layer. Functional but adds complexity."
    },
    "docker_worker_unavailable": {
        "detection": "AgentSwarm worker container orchestration is not available or incompatible",
        "fallback": "Supervisor runs Ollama worker as a local child process (no Docker isolation). Write-scope and command allowlist enforcement move to supervisor-level process monitoring.",
        "impact": "Reduced isolation. Workers run on host. Security risk mitigated by allowlist but not eliminated.",
        "security_note": "Document this in SECURITY.md. Recommend Docker worker isolation for production use."
    },
    "rule": "Every AgentSwarm dependency must have a documented fallback. Phase 1 reuse audit must record the fallback path for every component classified as 'wrap', 'extend', or 'build_new'."
}

# ==============================
# 5. WORKER EXECUTION ENVIRONMENT
# ==============================
c['ollama_worker_adapter']['worker_execution_environment'] = {
    "preferred": "docker_container",
    "fallback": "host_process",
    "docker_container": {
        "description": "Worker runs inside a Docker container managed by AgentSwarm (if AgentSwarm Docker orchestration is available). Write-scope is enforced via Docker volume mounts — only worktree path is mounted read-write. Network egress is controlled via Docker network policies derived from contract's network_requirements.",
        "volume_mounts": {
            "C:\\SkynetFactory\\worktrees\\<module_id>": "/workspace:rw",
            "C:\\SkynetFactory\\logs\\<module_id>": "/logs:rw"
        },
        "read_only_mounts": {
            "task_packet_path": "/task:ro"
        },
        "network_mode": "if network_requirements.requires_network is false, use --network none. Otherwise, use default network with iptables rules for allowed_hosts.",
        "detection": "AgentSwarm reuse audit classifies Docker worker orchestration as 'reuse' or 'extend'"
    },
    "host_process": {
        "description": "Worker runs as a supervised child process on the host. Write-scope enforcement is done by intercepting file system calls and validating against write_scope. Command allowlist enforcement intercepts shell commands. Network egress is monitored but harder to block on host.",
        "command_interception": "Worker adapter wraps each shell command in an allowlist check before execution. Blocked commands return exit code 1 with a descriptive error.",
        "file_write_interception": "Worker adapter hooks into the file system to validate each write against write_scope before allowing it. Implementation: TypeScript proxy around fs.writeFile or chokidar watcher that detects out-of-scope writes and rolls them back.",
        "detection": "AgentSwarm reuse audit classifies Docker worker orchestration as 'build_new' or unavailable"
    },
    "rule": "Use Docker container isolation when possible. Fall back to host process with interception only when Docker isolation is unavailable. Document which mode is active in supervisor health endpoint."
}

# ==============================
# 6. CONTRACT FILE NAMING IN STATE DIRECTORIES
# ==============================
c['contract_lifecycle']['file_naming_convention'] = {
    "contract_file": "<module_id>.json",
    "state_file": "<module_id>.state.json",
    "rule": "When a contract moves between state directories (pending/, claimed/, building/, etc.), two files move together: the contract JSON (<module_id>.json) and the state file (<module_id>.state.json). Both files are atomically moved (not copied) to the new directory. The contract file name never changes — only its directory location changes to indicate state.",
    "example": {
        "pending": "C:\\SkynetFactory\\module-contracts\\pending\\storage.integrity_verifier.json + storage.integrity_verifier.state.json",
        "building": "C:\\SkynetFactory\\module-contracts\\building\\storage.integrity_verifier.json + storage.integrity_verifier.state.json"
    },
    "worker_result_location": "After worker completion, worker_result.json is written to C:\\SkynetFactory\\worktrees\\<module_id>\\worker_result.json (inside the worktree). Supervisor copies it to C:\\SkynetFactory\\logs\\evidence\\<module_id>\\<timestamp>\\ during evidence bundle assembly.",
    "lockfile_location": "C:\\SkynetFactory\\temp\\claims\\<module_id>.lock (separate from state directories — persists across state transitions)"
}

# ==============================
# 7. API AUTHENTICATION & THREAT MODEL
# ==============================
c['supervisor_api_server']['authentication'] = {
    "threat_model": "SkyNetFactory is a local development tool running on a single developer's machine. The REST API and WebSocket server listen on localhost only. The threat model assumes: (1) only the developer and their tools (Codex, IDE) have access to localhost, (2) no untrusted code is running on the host, (3) the network is trusted (home/office LAN or loopback only).",
    "authentication": "none_for_v1",
    "justification": "Adding authentication to a localhost-only dev tool creates friction with no meaningful security benefit. If the host is compromised, localhost auth provides no real protection.",
    "binding": "The API server MUST bind to 127.0.0.1 (localhost only) — NEVER to 0.0.0.0. This prevents LAN access without authentication.",
    "future_consideration": "If SkyNetFactory is ever deployed as a shared server, add API key authentication and HTTPS.",
    "security_headers": "Add standard security headers to REST responses: X-Content-Type-Options: nosniff, Cache-Control: no-store for API responses."
}

# ==============================
# 8. ERROR RESPONSE FORMAT
# ==============================
c['supervisor_api_server']['error_response_format'] = {
    "success_shape": {
        "status": "success",
        "data": "<response payload>"
    },
    "error_shape": {
        "status": "error",
        "error": {
            "code": "string, e.g. 'CONTRACT_SCHEMA_INVALID', 'MODULE_NOT_FOUND', 'CLAIM_CONFLICT', 'AGENT_SWARM_UNREACHABLE'",
            "message": "human-readable string",
            "details": "optional object with additional context"
        }
    },
    "http_status_codes": {
        "200": "Success",
        "201": "Created (for POST /contracts)",
        "400": "Bad request (invalid contract JSON, invalid parameters)",
        "404": "Not found (module_id, contract, registry entry)",
        "409": "Conflict (claim conflict, module already exists)",
        "422": "Unprocessable (contract fails schema validation)",
        "500": "Internal server error",
        "503": "Service unavailable (AgentSwarm or Ollama unreachable)"
    }
}

# ==============================
# 9. PHASE DEPENDENCY GRAPH
# ==============================
c['execution_phase_dependencies'] = {
    "description": "Phases have dependencies that determine build order. No phase may start until all its dependencies are complete.",
    "graph": {
        "0": { "depends_on": [], "note": "Foundation - no dependencies" },
        "1": { "depends_on": ["0"], "note": "Needs AgentSwarm working copy to inspect" },
        "2": { "depends_on": ["0"], "note": "Needs folder structure to write schemas to" },
        "3": { "depends_on": ["1", "2"], "note": "Needs reuse audit (which AgentSwarm components to reuse) AND schemas (to validate contracts)" },
        "4": { "depends_on": ["3"], "note": "Needs adapter to submit tasks and translate contracts" },
        "5": { "depends_on": ["3", "4"], "note": "Needs adapter for task submission AND worker to produce results to gate-test" },
        "6": { "depends_on": ["3", "5"], "note": "Needs API server (from phase 3) AND gate results (from phase 5) to show" },
        "7": { "depends_on": ["4", "5", "6"], "note": "Needs worker, gates, and UI all functional for end-to-end test" }
    },
    "parallel_opportunities": {
        "phases_1_and_2": "Phase 1 (AgentSwarm audit) and Phase 2 (schema extraction) are independent and can run in parallel.",
        "phases_4_and_partial_5": "Worker adapter (phase 4) and gate runner (phase 5) can partially overlap — gate runner needs worker results for full testing but can be built independently first."
    }
}

# ==============================
# 10. UPDATE CHANGE LOG
# ==============================
v14_changes = [
    "Added implementation_languages: supervisor and all new code is TypeScript/Node",
    "Added happy_path_flow: 11-step sequence from contract placement to verified registration with failure path 9a",
    "Added contract_to_prompt_translation: 7-section prompt template structure, prompt engineering strategy",
    "Added context_window_strategy: 3-chunk implementation (scaffold, implementation, tests) with truncation detection",
    "Added agent_swarm_integration.graceful_degradation: 5 fallback paths for when AgentSwarm features are unavailable",
    "Added ollama_worker_adapter.worker_execution_environment: Docker container (preferred) vs host process (fallback)",
    "Added contract_lifecycle.file_naming_convention: <module_id>.json + <module_id>.state.json travel together, worker_result.json in worktree",
    "Added supervisor_api_server.authentication: localhost-only threat model, no auth for v1, must bind 127.0.0.1",
    "Added supervisor_api_server.error_response_format: consistent success/error shapes with HTTP status codes",
    "Added execution_phase_dependencies: dependency graph with parallel opportunities"
]
c['contract_versioning']['change_log'].append({
    "version": "1.4.0",
    "changes": v14_changes
})

# Write output
with open('skynetfactory_authority_contract_v1_4.json', 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)

print(f"v1.4.0 written. Total top-level keys: {len(c)}")
print(f"New sections: implementation_languages, happy_path_flow, contract_to_prompt_translation, execution_phase_dependencies")
print(f"Enriched sections: agent_swarm_integration.graceful_degradation, ollama_worker_adapter.worker_execution_environment, contract_lifecycle.file_naming_convention, supervisor_api_server.authentication, supervisor_api_server.error_response_format")