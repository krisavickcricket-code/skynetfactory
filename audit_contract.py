import json, re

with open('skynetfactory_authority_contract_v1_2.json', 'r') as f:
    c = json.load(f)

issues = []

# === 1. TOP LEVEL: $schema claims this IS a JSON Schema, but it's a data document ===
if c.get('$schema') == 'https://json-schema.org/draft/2020-12/schema':
    issues.append(("CRITICAL", "top-level", "$schema says this is a JSON Schema document, but it's a configuration/specification that CONTAINS schemas. Top-level $schema/$id are misleading."))

# === 2. Triple definition of remediation attempts ===
r1 = c.get('contract_lifecycle', {}).get('max_remediation_attempts')
r2 = c.get('retry_policy', {}).get('remediation_max_attempts')
r3 = c.get('configuration', {}).get('default', {}).get('max_remediation_attempts')
if r1 is not None and r2 is not None and r3 is not None:
    issues.append(("CRITICAL", "contract_lifecycle+retry_policy+configuration", f"max_remediation_attempts defined in THREE places: lifecycle={r1}, retry_policy={r2}, config={r3}. No authority declared."))

# === 3. Duplicate config values ===
dupes = {
    "parallel_workers": [
        c.get('concurrency_model', {}).get('parallel_workers_default'),
        c.get('configuration', {}).get('default', {}).get('parallel_workers')
    ],
    "default_ollama_model": [
        c.get('ollama_worker_adapter', {}).get('default_model'),
        c.get('llm_determinism', {}).get('model_fallback_chain', [None])[0],
        c.get('configuration', {}).get('default', {}).get('default_ollama_model')
    ],
    "default_temperature": [
        c.get('ollama_worker_adapter', {}).get('default_temperature'),
        c.get('llm_determinism', {}).get('default_temperature'),
        c.get('configuration', {}).get('default', {}).get('default_temperature')
    ],
    "circuit_breaker_trip_after": [
        c.get('retry_policy', {}).get('circuit_breaker_trip_after'),
        c.get('configuration', {}).get('default', {}).get('circuit_breaker_trip_after')
    ],
    "worker_timeout": [
        c.get('contract_lifecycle', {}).get('transitions', {}).get('building', {}).get('timeout_ms'),
        c.get('configuration', {}).get('default', {}).get('worker_timeout_ms')
    ],
    "ollama_host_url": [
        c.get('ollama_worker_adapter', {}).get('ollama_urls', {}).get('host'),
        c.get('configuration', {}).get('default', {}).get('ollama_host_url')
    ]
}
for key, vals in dupes.items():
    non_none = [v for v in vals if v is not None]
    if len(non_none) > 1:
        unique = set(str(v) for v in non_none)
        if len(unique) > 1:
            issues.append(("HIGH", f"duplicate:{key}", f"Conflicting values: {non_none}"))
        else:
            issues.append(("MEDIUM", f"duplicate:{key}", f"Same value in {len(non_none)} places - no authority specified"))

# === 4. $ref URIs with custom scheme won't resolve ===
contract_str = json.dumps(c)
custom_refs = re.findall(r'"\$ref":\s*"skynetfactory://[^"]*"', contract_str)
if custom_refs:
    issues.append(("HIGH", "schemas:$ref", f"Custom skynetfactory:// URI scheme in $ref won't resolve in any standard validator: {len(custom_refs)} references found"))

# === 5. Typo in building.on_timeout ===
building = c.get('contract_lifecycle', {}).get('transitions', {}).get('building', {})
if 'remediiation' in str(building.get('on_timeout', '')):
    issues.append(("MEDIUM", "contract_lifecycle:building.on_timeout", "Typo: 'remediiation' should be 'remediation'"))

# === 6. sidecar_requirements is misnamed ===
sample = c.get('sample_module_contract', {})
sr = sample.get('sidecar_requirements', {})
if 'agent_usage' in sr and 'common_calls' in sr:
    issues.append(("HIGH", "module_contract_schema:sidecar_requirements", "Field 'sidecar_requirements' contains FULL sidecar content (agent_usage, common_calls, failure_modes), not just requirements. Name is misleading."))

# === 7. Language-agnostic schema vs Node-specific gates ===
langs = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {}).get('properties', {}).get('language', {}).get('enum', [])
gates = c.get('acceptance_gate_engine', {}).get('gates', {})
node_only_gates = [k for k, v in gates.items() if 'npm' in str(v.get('command', ''))]
if langs and len(langs) > 1 and node_only_gates:
    issues.append(("HIGH", "acceptance_gate_engine:gates", f"Contract schema allows {len(langs)} languages {langs}, but gate commands are Node-only: {node_only_gates}"))

# === 8. Required output structure assumes Node ===
required_paths = c.get('module_output_required_structure', {}).get('required_paths', [])
if 'package.json' in required_paths:
    issues.append(("HIGH", "module_output_required_structure", "'package.json' in required_paths assumes Node. Python/Go/Rust modules would have different manifests."))

# === 9. Who serves the REST API? ===
ui_transport = c.get('electron_ui', {}).get('ui_transport', {})
if ui_transport.get('rest_base'):
    issues.append(("HIGH", "electron_ui:ui_transport", f"REST base {ui_transport['rest_base']} - served by whom? AgentSwarm? Supervisor? Not specified."))

# === 10. Git worktree model underspecified ===
rollback = c.get('rollback_policy', {})
if rollback.get('worktree_strategy'):
    issues.append(("HIGH", "rollback_policy", "worktree_strategy says 'one_git_worktree_per_module' but doesn't specify: which repo? which branch naming? how do worktrees relate to production-modules?"))

# === 11. Missing config/migrations path ===
cv = c.get('contract_versioning', {})
if 'migrations' in str(cv.get('migration_strategy', '')):
    paths_keys = list(c.get('paths', {}).keys())
    folders = c.get('folder_structure_required', [])
    if 'migrations' not in str(paths_keys) and 'migrations' not in str(folders):
        issues.append(("MEDIUM", "paths+folder_structure", "contract_versioning references config/migrations/ but it's not in paths or folder_structure_required"))

# === 12. attempt_count tracking undefined ===
remediation_guard = c.get('contract_lifecycle', {}).get('transitions', {}).get('remediation', {}).get('guard', '')
if 'attempt_count' in remediation_guard:
    issues.append(("HIGH", "contract_lifecycle:remediation.guard", "'attempt_count <= max_remediation_attempts' - but WHERE is attempt_count tracked? Not specified."))

# === 13. Lockfile format undefined ===
concurrency = c.get('concurrency_model', {})
if concurrency.get('rule') and 'worker_id' in concurrency.get('rule', ''):
    issues.append(("MEDIUM", "concurrency_model:rule", "Lockfile must contain worker_id, claimed_at, expected_completion - but no format specified (JSON? plain text?)"))

# === 14. Health check required vs warn contradiction ===
for probe in c.get('health_checks', {}).get('startup_probes', []):
    if probe.get('name') == 'ollama_default_model':
        if probe.get('required') and 'warn' in str(probe.get('on_failure', '')):
            issues.append(("HIGH", "health_checks:ollama_default_model", "Probe marked required=true but on_failure says 'warn' - contradictory."))

# === 15. No network_requirements field ===
issues.append(("HIGH", "module_contract_schema", "No 'network_requirements' field. Workers monitor egress, but modules that NEED network access have no way to declare it."))

# === 16. write_scope derivation undefined ===
if 'write_scope' in str(c.get('ollama_worker_adapter', {}).get('worker_input', {})):
    issues.append(("HIGH", "ollama_worker_adapter:worker_input", "write_scope listed in worker_input but never specified WHERE it comes from or who derives it."))

# === 17. No POST endpoints in UI ===
rest_eps = ui_transport.get('rest_endpoints', {})
has_post = any('POST' in str(v) for v in rest_eps.values())
if not has_post:
    issues.append(("MEDIUM", "electron_ui:rest_endpoints", "No POST/PUT endpoints for creating contracts or triggering actions. UI appears read-only."))

# === 18. registry_entry_schema.capability_type lacks enum ===
re_ct = c.get('module_contract_authoring_standard', {}).get('registry_entry_schema', {}).get('properties', {}).get('capability_type', {})
mc_ct = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {}).get('properties', {}).get('capability_type', {})
if 'enum' not in re_ct and 'enum' in mc_ct:
    issues.append(("MEDIUM", "registry_entry_schema:capability_type", "Module contract has capability_type as 9-value enum, but registry entry has it as plain string. Should match."))

# === 19. gate_result_schema missing $schema/$id ===
grs = c.get('acceptance_gate_engine', {}).get('gate_result_schema', {})
if '$schema' not in grs:
    issues.append(("LOW", "gate_result_schema", "Missing $schema and $id declarations (all other schemas have them)"))

# === 20. Static analysis tools unspecified ===
fb_valid = c.get('acceptance_gate_engine', {}).get('gates', {}).get('forbidden_behavior_validation', {}).get('detection_methods', {}).get('static_analysis', '')
if 'flagged in contract' in fb_valid:
    issues.append(("HIGH", "forbidden_behavior_validation:static_analysis", "Says 'run tools flagged in contract' but module contract schema has NO field for specifying which static analysis tools."))

# === 21. Worker shell environment unspecified ===
issues.append(("MEDIUM", "ollama_worker_adapter", "disallowed_patterns includes PowerShell cmdlets but allowed_commands are Unix/cmd style. No shell specification."))

# === 22. Terminal state revival - artifacts ===
issues.append(("MEDIUM", "contract_lifecycle:completed+rejected", "When completed->pending or rejected->pending, what happens to existing production module artifacts? Not specified."))

# === 23. system_roles not updated ===
supervisor_resp = c.get('system_roles', {}).get('skynetfactory_supervisor', {}).get('responsibilities', [])
missing_resp = []
for check in ['lock', 'circuit', 'health', 'rollback']:
    if check not in str(supervisor_resp).lower():
        missing_resp.append(check)
if missing_resp:
    issues.append(("MEDIUM", "system_roles:skynetfactory_supervisor", f"Responsibilities missing: {missing_resp}"))

# === 24. reuse_policy.build_new_only_for incomplete ===
build_new = c.get('reuse_policy', {}).get('build_new_only_for', [])
missing_new = ['forbidden_behavior gate runner', 'health check system', 'circuit breaker', 'concurrency lock manager', 'REST API layer']
for item in missing_new:
    found = any(item.split()[0].lower() in b.lower() for b in build_new)
    if not found:
        issues.append(("LOW", "reuse_policy:build_new_only_for", f"Missing: '{item}'"))

# === 25. must_inspect_before_coding missing websocket/events ===
inspect_list = c.get('reuse_policy', {}).get('must_inspect_before_coding', [])
if 'websocket' not in str(inspect_list).lower() and 'event' not in str(inspect_list).lower():
    issues.append(("MEDIUM", "reuse_policy:must_inspect_before_coding", "Missing: websocket/event system - now referenced by agent_swarm_integration"))

# === 26. success_definition incomplete ===
success = c.get('success_definition', [])
if 'health' not in str(success).lower():
    issues.append(("LOW", "success_definition", "No mention of health checks being operational"))

# === 27. LLM fallback vs circuit breaker overlap ===
fallback_trigger = c.get('llm_determinism', {}).get('fallback_trigger', '')
cb_trip = c.get('retry_policy', {}).get('circuit_breaker_trip_after', None)
if '3' in str(fallback_trigger) and cb_trip:
    issues.append(("MEDIUM", "llm_determinism+retry_policy", f"Model fallback triggers at 3 failures, circuit breaker at {cb_trip}. Do they share a counter? Is 3 failures -> fallback ALSO counted toward {cb_trip} for circuit breaker? Not specified."))

# === 28. Sample module sidecar_requirements should validate against sidecar schema ===
sr_schema = c.get('module_contract_authoring_standard', {}).get('sidecar_schema', {}).get('required', [])
sr_missing = [f for f in sr_schema if f not in sr]
if sr_missing:
    issues.append(("HIGH", "sample_module_contract:sidecar_requirements", f"Required sidecar fields missing from sample: {sr_missing}"))

# === 29. AgentSwarm event streaming: who initiates? ===
events = c.get('agent_swarm_integration', {}).get('event_streaming', {})
if events:
    issues.append(("MEDIUM", "agent_swarm_integration:event_streaming", f"Direction '{events.get('direction')}' but no spec for who initiates, what event types exist, or how supervisor subscribes."))

# === 30. Docker compose V1 vs V2 ===
docker_cmd = c.get('acceptance_gate_engine', {}).get('gates', {}).get('docker_tests', {}).get('command', '')
if 'docker compose' in docker_cmd:
    issues.append(("LOW", "docker_tests:command", "Uses 'docker compose' (V2). Should also allow 'docker-compose' (V1) or specify which."))

# Print all issues
print(f"Total issues found: {len(issues)}")
print()
severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
for severity, location, description in sorted(issues, key=lambda x: severity_order[x[0]]):
    print(f"[{severity}] {location}")
    print(f"  {description}")
    print()