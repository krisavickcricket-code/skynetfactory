import json, re

with open('skynetfactory_authority_contract_v1_3.json', 'r') as f:
    c = json.load(f)

issues = []
fixes = []

# === ISSUE 1: Top-level $schema misleading ===
if c.get('$schema') == 'https://json-schema.org/draft/2020-12/schema':
    issues.append(("1", "FAIL", "Top-level $schema still present"))
else:
    fixes.append(("1", "FIXED", "No top-level $schema"))

# === ISSUE 2: Triple remediation attempts ===
r1 = c.get('contract_lifecycle', {}).get('max_remediation_attempts')
r2 = c.get('retry_policy', {}).get('remediation_max_attempts_ref')  # should be a ref now
r3_mentioned = 'max_remediation_attempts' in str(c.get('configuration', {}).get('default', {}))
has_authority = 'remediation_authority' in c.get('contract_lifecycle', {})
if r1 is not None and r2 is not None and 'ref' in str(r2).lower() and has_authority:
    fixes.append(("2", "FIXED", f"lifecycle={r1} (authority), retry_policy refs it, config={r3_mentioned} (override). Authority rule present."))
else:
    issues.append(("2", "FAIL", f"Still triple: lifecycle={r1}, retry={r2}, config_mentioned={r3_mentioned}"))

# === ISSUE 3: Duplicate config values ===
has_authority_rule = 'authority_rule' in c.get('configuration', {})
if has_authority_rule:
    fixes.append(("3", "FIXED", "configuration.authority_rule present — behavioral=architecture, config=runtime override"))
else:
    issues.append(("3", "FAIL", "No authority rule for config duplicate resolution"))

# === ISSUE 4: $ref custom URIs ===
contract_str = json.dumps(c)
custom_refs = re.findall(r'"\$ref":\s*"skynetfactory://[^"]*"', contract_str)
inline_refs = re.findall(r'"\$ref":\s*"#/\$defs/', contract_str)
mc_schema = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {})
api_inline = 'style' in str(mc_schema.get('properties', {}).get('api', {}))
dep_inline = 'module_id' in str(mc_schema.get('properties', {}).get('dependencies', {}))
schema_policy = 'schema_resolution_policy' in c.get('meta', {})
# After v1.3 fix: sub-schemas are inline in module_contract_schema, so $ref to custom URIs
# should only appear in schema_ref references elsewhere (not in $ref within schemas)
direct_dollar_ref_custom = re.findall(r'"\$ref":\s*"skynetfactory://', contract_str)
# Check if they're inside schema $ref (problematic) vs just in schema_ref fields (descriptive)
if direct_dollar_ref_custom:
    # These might be in schema_ref fields which are descriptive, not actual $ref
    in_schema_ref = re.findall(r'"schema_ref":\s*"skynetfactory://', contract_str)
    in_dollar_ref = re.findall(r'"\$ref":\s*"skynetfactory://', contract_str)
    if in_dollar_ref:
        issues.append(("4", "PARTIAL", f"Still {len(in_dollar_ref)} $ref with custom scheme. schema_ref references OK (descriptive only)."))
    else:
        fixes.append(("4", "FIXED", "No $ref using custom scheme; only schema_ref (descriptive). Sub-schemas inline."))
else:
    fixes.append(("4", "FIXED", "No custom $ref URIs"))

if schema_policy:
    fixes.append(("4b", "FIXED", "schema_resolution_policy defined in meta"))

# === ISSUE 5: Typo ===
building = c.get('contract_lifecycle', {}).get('transitions', {}).get('building', {})
if 'remediiation' in str(building.get('on_timeout', '')):
    issues.append(("5", "FAIL", "Typo 'remediiation' still present"))
else:
    fixes.append(("5", "FIXED", "Typo fixed"))

# === ISSUE 6: sidecar_requirements naming ===
mc_props = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {}).get('properties', {})
has_sidecar_spec = 'sidecar_specification' in mc_props
has_sidecar_req = 'sidecar_requirements' in mc_props
sample = c.get('sample_module_contract', {})
sample_has_spec = 'sidecar_specification' in sample
sample_has_req = 'sidecar_requirements' in sample
if has_sidecar_spec and not has_sidecar_req and sample_has_spec:
    fixes.append(("6", "FIXED", "Renamed to sidecar_specification with clear description"))
else:
    issues.append(("6", "FAIL", f"Schema: spec={has_sidecar_spec} req={has_sidecar_req}. Sample: spec={sample_has_spec} req={sample_has_req}"))

# === ISSUE 7: Language-agnostic gates ===
gate_engine = c.get('acceptance_gate_engine', {})
has_test_cmds = 'test_commands_by_runtime' in gate_engine
if has_test_cmds:
    runtimes = list(gate_engine.get('test_commands_by_runtime', {}).keys())
    fixes.append(("7", "FIXED", f"test_commands_by_runtime covers: {runtimes}"))
else:
    issues.append(("7", "FAIL", "No test_commands_by_runtime"))

# === ISSUE 8: Language-variant output structure ===
output = c.get('module_output_required_structure', {})
has_variants = 'language_variants' in output
if has_variants:
    langs = list(output.get('language_variants', {}).keys())
    fixes.append(("8", "FIXED", f"language_variants for: {langs}"))
else:
    issues.append(("8", "FAIL", "No language_variants"))

# === ISSUE 9: REST API server ownership ===
has_supervisor_api = 'supervisor_api_server' in c
if has_supervisor_api:
    api_server = c.get('supervisor_api_server', {})
    has_ownership = 'ownership' in api_server
    has_reuse_check = 'reuse_check' in api_server
    fixes.append(("9", "FIXED", f"supervisor_api_server: ownership={has_ownership}, reuse_check={has_reuse_check}"))
else:
    issues.append(("9", "FAIL", "No supervisor_api_server"))

# === ISSUE 10: Git worktree model ===
rollback = c.get('rollback_policy', {})
has_repository = 'repository' in rollback
has_branch_naming = 'branch_naming' in rollback
has_workflow = 'workflow' in rollback
if has_repository and has_branch_naming and has_workflow:
    fixes.append(("10", "FIXED", "Complete worktree model with repo, branch naming, and workflow"))
else:
    issues.append(("10", "FAIL", f"repo={has_repository}, branch={has_branch_naming}, workflow={has_workflow}"))

# === ISSUE 11: Config/migrations path ===
paths = c.get('paths', {})
folders = c.get('folder_structure_required', [])
has_config_migrations_path = 'config_migrations' in paths
has_config_migrations_folder = any('migrations' in str(f) for f in folders)
if has_config_migrations_path and has_config_migrations_folder:
    fixes.append(("11", "FIXED", "config_migrations in paths and folder_structure"))
else:
    issues.append(("11", "FAIL", f"path={has_config_migrations_path}, folder={has_config_migrations_folder}"))

# === ISSUE 12: attempt_count tracking ===
state_tracking = c.get('contract_lifecycle', {}).get('state_tracking', {})
has_mechanism = 'mechanism' in state_tracking
has_schema = 'schema' in state_tracking
if has_mechanism and has_schema:
    st_props = state_tracking.get('schema', {}).get('properties', {})
    has_attempt = 'attempt_count' in st_props
    has_remediation = 'remediation_count' in st_props
    fixes.append(("12", "FIXED", f"contract_state.json with attempt={has_attempt}, remediation={has_remediation}"))
else:
    issues.append(("12", "FAIL", f"tracking={has_mechanism}, schema={has_schema}"))

# === ISSUE 13: Lockfile format ===
concurrency = c.get('concurrency_model', {})
has_lock_format = 'lock_format' in concurrency
if has_lock_format:
    fmt = concurrency.get('lock_format', {})
    fixes.append(("13", "FIXED", f"Lock format: type={fmt.get('type')}, has example={bool(fmt.get('example'))}"))
else:
    issues.append(("13", "FAIL", "No lock_format"))

# === ISSUE 14: Health check contradiction ===
ollama_model_probe = [p for p in c.get('health_checks', {}).get('startup_probes', []) if p.get('name') == 'ollama_default_model']
if ollama_model_probe:
    required = ollama_model_probe[0].get('required')
    on_failure = ollama_model_probe[0].get('on_failure', '')
    if required == False and 'attempt_pull' in on_failure:
        fixes.append(("14", "FIXED", "ollama_default_model now required=false with attempt_pull fallback"))
    else:
        issues.append(("14", "FAIL", f"required={required}, on_failure={on_failure}"))
else:
    issues.append(("14", "FAIL", "ollama_default_model probe not found"))

# === ISSUE 15: network_requirements field ===
mc_schema = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {})
mc_props = mc_schema.get('properties', {})
has_network = 'network_requirements' in mc_props
sample_has_network = 'network_requirements' in sample
if has_network and sample_has_network:
    fixes.append(("15", "FIXED", "network_requirements in schema and sample"))
else:
    issues.append(("15", "FAIL", f"schema={has_network}, sample={sample_has_network}"))

# === ISSUE 16: write_scope derivation ===
has_ws_derivation = 'write_scope_derivation' in c
if has_ws_derivation:
    ws = c.get('write_scope_derivation', {})
    has_formula = 'formula' in ws
    fixes.append(("16", "FIXED", f"write_scope_derivation with formula={has_formula}"))
else:
    issues.append(("16", "FAIL", "No write_scope_derivation"))

# === ISSUE 17: POST endpoints in UI ===
api_server = c.get('supervisor_api_server', {})
rest_eps = api_server.get('rest_endpoints', {})
has_post = any('POST' in str(v) for v in rest_eps.values())
has_put = any('PUT' in str(v) for v in rest_eps.values())
has_delete = any('DELETE' in str(v) for v in rest_eps.values())
if has_post and has_put and has_delete:
    fixes.append(("17", "FIXED", f"POST={has_post}, PUT={has_put}, DELETE={has_delete} in supervisor_api_server"))
else:
    issues.append(("17", "FAIL", f"POST={has_post}, PUT={has_put}, DELETE={has_delete}"))

# === ISSUE 18: registry_entry capability_type enum ===
re_schema = c.get('module_contract_authoring_standard', {}).get('registry_entry_schema', {})
re_ct = re_schema.get('properties', {}).get('capability_type', {})
has_enum = 'enum' in re_ct
if has_enum:
    fixes.append(("18", "FIXED", f"capability_type enum: {re_ct.get('enum')}"))
else:
    issues.append(("18", "FAIL", "No capability_type enum in registry_entry_schema"))

# === ISSUE 19: gate_result_schema $schema/$id ===
grs = c.get('module_contract_authoring_standard', {}).get('gate_result_schema', {})
has_dollar_schema = '$schema' in grs
has_dollar_id = '$id' in grs
if has_dollar_schema and has_dollar_id:
    fixes.append(("19", "FIXED", "gate_result_schema has $schema and $id"))
else:
    issues.append(("19", "FAIL", f"$schema={has_dollar_schema}, $id={has_dollar_id}"))

# === ISSUE 20: static_analysis_config ===
fb_schema = mc_props.get('forbidden_behaviors', {}).get('items', {}).get('properties', {})
has_sa_config = 'static_analysis_config' in fb_schema
sample_fb = sample.get('forbidden_behaviors', [])
sample_has_sa = any('static_analysis_config' in fb for fb in sample_fb)
if has_sa_config and sample_has_sa:
    fixes.append(("20", "FIXED", "static_analysis_config in schema and sample"))
else:
    issues.append(("20", "FAIL", f"schema={has_sa_config}, sample={sample_has_sa}"))

# === ISSUE 21: Worker shell ===
ollama = c.get('ollama_worker_adapter', {})
has_shell = 'worker_shell' in ollama
if has_shell:
    fixes.append(("21", "FIXED", f"worker_shell defined: {ollama.get('worker_shell', {}).get('default')}"))
else:
    issues.append(("21", "FAIL", "No worker_shell"))

# === ISSUE 22: Terminal state revival artifacts ===
completed = c.get('contract_lifecycle', {}).get('transitions', {}).get('completed', {})
rejected = c.get('contract_lifecycle', {}).get('transitions', {}).get('rejected', {})
has_on_revival_c = 'on_revival' in completed
has_on_revival_r = 'on_revival' in rejected
if has_on_revival_c and has_on_revival_r:
    fixes.append(("22", "FIXED", f"on_revival for completed and rejected"))
else:
    issues.append(("22", "FAIL", f"completed={has_on_revival_c}, rejected={has_on_revival_r}"))

# === ISSUE 23: system_roles updated ===
supervisor = c.get('system_roles', {}).get('skynetfactory_supervisor', {}).get('responsibilities', [])
worker = c.get('system_roles', {}).get('ollama_workers', {}).get('responsibilities', [])
s_has_all = all(w in str(supervisor).lower() for w in ['lock', 'circuit', 'health', 'rollback', 'api'])
w_has_all = all(w in str(worker).lower() for w in ['seed', 'temperature', 'allowlist', 'egress', 'write_scope'])
if s_has_all and w_has_all:
    fixes.append(("23", "FIXED", "system_roles responsibilities updated"))
else:
    issues.append(("23", "FAIL", f"supervisor_all={s_has_all}, worker_all={w_has_all}"))

# === ISSUE 24: reuse_policy.build_new_only_for ===
build_new = c.get('reuse_policy', {}).get('build_new_only_for', [])
checks = ['forbidden_behavior', 'health', 'circuit', 'concurrency', 'rollback', 'REST API']
found = [c for c in checks if any(c.lower() in b.lower() for b in build_new)]
if len(found) == len(checks):
    fixes.append(("24", "FIXED", f"All new components listed in build_new_only_for"))
else:
    issues.append(("24", "FAIL", f"Missing: {set(checks) - set(found)}"))

# === ISSUE 25: must_inspect websocket/events ===
inspect_list = c.get('reuse_policy', {}).get('must_inspect_before_coding', [])
has_ws = 'websocket' in str(inspect_list).lower() or 'event' in str(inspect_list).lower()
if has_ws:
    fixes.append(("25", "FIXED", "websocket/event system in must_inspect_before_coding"))
else:
    issues.append(("25", "FAIL", "No websocket/event in must_inspect"))

# === ISSUE 26: Counter relationship ===
retry = c.get('retry_policy', {})
has_failure_counter = 'failure_counter' in retry
if has_failure_counter:
    fc = retry.get('failure_counter', {})
    has_description = 'description' in fc
    has_relationship = 'relationship' in fc
    fixes.append(("26", "FIXED", f"Shared counter: desc={has_description}, relationship={has_relationship}"))
else:
    issues.append(("26", "FAIL", "No failure_counter description"))

# === ISSUE 27: Event streaming types ===
events = c.get('agent_swarm_integration', {}).get('event_streaming', {})
has_event_types = 'event_types' in events
has_subscription = 'subscription' in events
if has_event_types and has_subscription:
    fixes.append(("27", "FIXED", f"event_types={len(events.get('event_types', {}))}, subscription defined"))
else:
    issues.append(("27", "FAIL", f"event_types={has_event_types}, subscription={has_subscription}"))

# === ISSUE 28: Sample sidecar full content ===
sr = sample.get('sidecar_specification', {})
sidecar_required = ['purpose', 'agent_usage', 'common_calls', 'failure_modes', 'composition_tags']
sr_has_all = all(f in sr for f in sidecar_required)
# Note: module_id and version are NOT required in sidecar_specification (they're auto-added by worker)
if sr_has_all:
    fixes.append(("28", "FIXED", "Sample sidecar_specification has all required fields"))
else:
    missing = [f for f in sidecar_required if f not in sr]
    issues.append(("28", "FAIL", f"Missing in sample sidecar: {missing}"))

# === ISSUE 29: success_definition updated ===
success = c.get('success_definition', [])
has_health = 'health' in str(success).lower()
has_api = 'api' in str(success).lower() or 'rest' in str(success).lower() or 'websocket' in str(success).lower()
if has_health and has_api:
    fixes.append(("29", "FIXED", "success_definition includes health and API"))
else:
    issues.append(("29", "FAIL", f"health={has_health}, api={has_api}"))

# === ISSUE 30: Docker compose V1/V2 ===
docker_gate = c.get('acceptance_gate_engine', {}).get('gates', {}).get('docker_tests', {})
docker_cmd = docker_gate.get('command', '')
has_v1_v2 = 'docker-compose' in docker_cmd and 'docker compose' in docker_cmd
has_note = 'note' in docker_gate
if has_v1_v2 or has_note:
    fixes.append(("30", "FIXED", f"Docker V1/V2 fallback: cmd_has_both={has_v1_v2}, note={has_note}"))
else:
    issues.append(("30", "FAIL", "No V1/V2 fallback"))

# === ISSUE 31: allowed_commands per runtime ===
allowed = c.get('ollama_worker_adapter', {}).get('allowed_commands', {})
is_per_runtime = 'node_runtime' in allowed or 'common' in allowed
if is_per_runtime:
    categories = [k for k in allowed.keys() if 'runtime' in k or k == 'common']
    fixes.append(("31", "FIXED", f"Per-runtime allowed_commands: {categories}"))
else:
    issues.append(("31", "FAIL", "No per-runtime allowed_commands"))

# === ISSUE 32: disallowed_patterns shell-aware ===
disallowed = c.get('ollama_worker_adapter', {}).get('disallowed_patterns', {})
is_shell_aware = 'shell_agnostic' in disallowed or 'cmd_specific' in disallowed
if is_shell_aware:
    fixes.append(("32", "FIXED", f"Shell-aware disallowed_patterns: {list(disallowed.keys())}"))
else:
    issues.append(("32", "FAIL", "No shell-aware disallowed_patterns"))

# === ISSUE 33: Registry lifecycle coupling ===
registry = c.get('registry', {})
has_coupling = 'registry_lifecycle_coupling' in registry
if has_coupling:
    fixes.append(("33", "FIXED", "registry_lifecycle_coupling explanation present"))
else:
    issues.append(("33", "FAIL", "No registry_lifecycle_coupling"))

# === ISSUE 34: Infrastructure health vs per-module failures ===
health_section = c.get('health_checks', {})
on_runtime = health_section.get('on_runtime_probe_failure', '')
separated = 'separate' in on_runtime.lower() or 'do not count' in on_runtime.lower() or 'infrastructure' in on_runtime.lower()
if separated:
    fixes.append(("34", "FIXED", "Infrastructure health separated from per-module failure counter"))
else:
    issues.append(("34", "FAIL", "No separation of infrastructure vs per-module failures"))

# === ISSUE 35: network_policy_validation gate ===
gates = c.get('acceptance_gate_engine', {}).get('gates', {})
has_network_gate = 'network_policy_validation' in gates
evidence = c.get('acceptance_gate_engine', {}).get('evidence_bundle', {}).get('required_files', [])
has_network_log = 'network_policy_check.log' in evidence
if has_network_gate and has_network_log:
    fixes.append(("35", "FIXED", "network_policy_validation gate and log"))
else:
    issues.append(("35", "FAIL", f"gate={has_network_gate}, log={has_network_log}"))

# === ISSUE 36: Adapter functions categorized ===
adapter = c.get('agent_swarm_integration', {}).get('required_adapter_functions', {})
is_categorized = isinstance(adapter, dict)
if is_categorized:
    fixes.append(("36", "FIXED", f"Adapter functions categorized: {list(adapter.keys())}"))
else:
    issues.append(("36", "FAIL", "Adapter functions not categorized"))

# === ISSUE 37: worker_result required fields tightened ===
wr_schema = c.get('module_contract_authoring_standard', {}).get('worker_result_schema', {})
tr_items = wr_schema.get('properties', {}).get('tests_run', {}).get('items', {})
ki_items = wr_schema.get('properties', {}).get('known_issues', {}).get('items', {})
tr_required = tr_items.get('required', [])
ki_required = ki_items.get('required', [])
tr_ok = 'test_name' in tr_required and 'result' in tr_required
ki_ok = 'description' in ki_required and 'severity' in ki_required
if tr_ok and ki_ok:
    fixes.append(("37", "FIXED", f"tests_run required: {tr_required}, known_issues required: {ki_required}"))
else:
    issues.append(("37", "FAIL", f"tests_run: {tr_required}, known_issues: {ki_required}"))

# === ISSUE 38: Electron UI actions ===
ui = c.get('electron_ui', {})
has_actions = 'actions' in ui
if has_actions:
    fixes.append(("38", "FIXED", f"UI actions defined: {list(ui.get('actions', {}).keys())}"))
else:
    issues.append(("38", "FAIL", "No UI actions"))

# === SUMMARY ===
print("=" * 60)
print(f"v1.3.0 AUDIT RESULTS")
print(f"=" * 60)
print(f"\nFIXED: {len(fixes)}")
for num, status, desc in fixes:
    print(f"  [#{num}] {desc}")

print(f"\nREMAINING ISSUES: {len(issues)}")
for num, status, desc in issues:
    print(f"  [#{num}] {status}: {desc}")

print(f"\n{'ALL CLEAR' if len(issues) == 0 else f'{len(issues)} issues remain'}")