import json

with open('skynetfactory_authority_contract_v1_3.json', 'r') as f:
    c = json.load(f)

cross_refs = []

# Sample vs schema required fields
sample = c.get('sample_module_contract', {})
mc_required = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {}).get('required', [])
sample_missing = [f for f in mc_required if f not in sample]
if sample_missing:
    cross_refs.append(("WARN", "sample_vs_schema", f"Sample contract missing required fields: {sample_missing}"))
else:
    cross_refs.append(("OK", "sample_vs_schema", "Sample contract has all required fields"))

# Sample acceptance_gates match gate engine gates
sample_gates = set(sample.get('acceptance_gates', []))
engine_gates = set(c.get('acceptance_gate_engine', {}).get('gates', {}).keys())
gates_not_in_engine = sample_gates - engine_gates
if gates_not_in_engine:
    cross_refs.append(("WARN", "sample_gates", f"Sample gates not in engine: {gates_not_in_engine}"))
else:
    cross_refs.append(("OK", "sample_gates", "All sample gates exist in gate engine"))

# Config defaults match behavioral defaults
config = c.get('configuration', {}).get('default', {})
behavioral = {
    'max_remediation_attempts': c.get('contract_lifecycle', {}).get('max_remediation_attempts'),
    'parallel_workers': c.get('concurrency_model', {}).get('parallel_workers_default'),
    'lock_timeout_ms': c.get('concurrency_model', {}).get('lock_timeout_ms'),
}
config_eq = {
    'max_remediation_attempts': config.get('max_remediation_attempts'),
    'parallel_workers': config.get('parallel_workers'),
    'lock_timeout_ms': config.get('lock_timeout_ms'),
}
mismatches = []
for key in behavioral:
    b = behavioral[key]
    cfg = config_eq.get(key)
    if b is not None and cfg is not None and b != cfg:
        mismatches.append(f"{key}: behavioral={b}, config={cfg}")
if mismatches:
    cross_refs.append(("WARN", "config_vs_behavioral", f"Mismatches: {mismatches}"))
else:
    cross_refs.append(("OK", "config_vs_behavioral", "All config defaults match behavioral defaults"))

# Sample runtime in test_commands_by_runtime
sample_runtime = sample.get('runtime')
test_cmds = c.get('acceptance_gate_engine', {}).get('test_commands_by_runtime', {})
if sample_runtime in test_cmds:
    cross_refs.append(("OK", "sample_runtime", f"Sample runtime '{sample_runtime}' in test_commands"))
else:
    cross_refs.append(("WARN", "sample_runtime", f"Sample runtime '{sample_runtime}' NOT in test_commands: {list(test_cmds.keys())}"))

# Sample language in language_variants
sample_lang = sample.get('language')
lang_vars = c.get('module_output_required_structure', {}).get('language_variants', {})
if sample_lang in lang_vars:
    cross_refs.append(("OK", "sample_language", f"Sample language '{sample_lang}' in language_variants"))
else:
    cross_refs.append(("WARN", "sample_language", f"Sample language '{sample_lang}' NOT in variants: {list(lang_vars.keys())}"))

# API port consistency
api_port = c.get('supervisor_api_server', {}).get('port')
api_ws = c.get('supervisor_api_server', {}).get('websocket_url', '')
api_rest = c.get('supervisor_api_server', {}).get('rest_base', '')
ui_ws = c.get('electron_ui', {}).get('api_connection', {}).get('websocket_url', '')
ui_rest = c.get('electron_ui', {}).get('api_connection', {}).get('rest_base', '')
port_ok = str(api_port) in api_ws and str(api_port) in api_rest
ui_match = api_ws == ui_ws and api_rest == ui_rest
if port_ok and ui_match:
    cross_refs.append(("OK", "api_consistency", f"All URLs use port {api_port}, UI matches supervisor"))
else:
    cross_refs.append(("WARN", "api_consistency", f"Port={api_port}, ws_match={ui_match}, port_in_urls={port_ok}"))

# Sample sidecar_specification matches sidecar_schema required
sidecar_req = c.get('module_contract_authoring_standard', {}).get('sidecar_schema', {}).get('required', [])
sample_sidecar = sample.get('sidecar_specification', {})
# Note: sidecar_schema requires module_id and version, but sidecar_specification in contract doesn't require them
# (those are added by worker). Check what's expected.
spec_required = c.get('module_contract_authoring_standard', {}).get('module_contract_schema', {}).get('properties', {}).get('sidecar_specification', {}).get('required', [])
spec_missing = [f for f in spec_required if f not in sample_sidecar]
if spec_missing:
    cross_refs.append(("WARN", "sample_sidecar_spec", f"Missing required fields: {spec_missing}"))
else:
    cross_refs.append(("OK", "sample_sidecar_spec", "Sample sidecar_specification has all required fields"))

# v1.3 changelog
v13 = [cl for cl in c.get('contract_versioning', {}).get('change_log', []) if cl.get('version') == '1.3.0']
if v13:
    n = len(v13[0].get('changes', []))
    cross_refs.append(("INFO", "v1.3_changelog", f"{n} changes documented"))

# Fallback chain consistency
llm_chain = c.get('llm_determinism', {}).get('model_fallback_chain', [])
ollama_fallback = c.get('ollama_worker_adapter', {}).get('fallback_models', [])
config_fallback = config.get('fallback_models', [])
if llm_chain[1:] == ollama_fallback and ollama_fallback == config_fallback:
    cross_refs.append(("OK", "fallback_models", f"Consistent across all sections: primary={llm_chain[0]}, fallbacks={ollama_fallback}"))
else:
    cross_refs.append(("WARN", "fallback_models", f"llm_chain={llm_chain}, ollama={ollama_fallback}, config={config_fallback}"))

# Ollama URL consistency
ollama_host = c.get('ollama_worker_adapter', {}).get('ollama_urls', {}).get('host')
config_ollama = config.get('ollama_host_url')
health_ollama = [p.get('url') for p in c.get('health_checks', {}).get('startup_probes', []) if 'ollama' in p.get('name', '')]
if ollama_host == config_ollama and all(ollama_host in u for u in health_ollama):
    cross_refs.append(("OK", "ollama_url", f"Consistent: {ollama_host}"))
else:
    cross_refs.append(("WARN", "ollama_url", f"ollama_host={ollama_host}, config={config_ollama}, health={health_ollama}"))

# success_definition count
success = c.get('success_definition', [])
cross_refs.append(("INFO", "success_definition", f"{len(success)} criteria"))

# phases count
phases = c.get('execution_phases', [])
cross_refs.append(("INFO", "phases", f"{len(phases)} phases (0-{len(phases)-1})"))

print("=" * 60)
print("CROSS-REFERENCE VALIDATION: v1.3.0")
print("=" * 60)
for status, location, desc in cross_refs:
    icon = {"OK": "+", "WARN": "!", "INFO": "i"}.get(status, "?")
    print(f"  [{icon} {status}] {location}: {desc}")

warns = [r for r in cross_refs if r[0] == "WARN"]
oks = [r for r in cross_refs if r[0] == "OK"]
infos = [r for r in cross_refs if r[0] == "INFO"]
print(f"\nSummary: {len(oks)} OK, {len(warns)} warnings, {len(infos)} info")
if warns:
    print("Warnings to review:")
    for s, l, d in warns:
        print(f"  - {l}: {d}")