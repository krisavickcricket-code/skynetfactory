# SkyNetFactory Naming Rules

## Module ID Format

`<domain>.<capability_name>`

### Examples
- `storage.integrity_verifier`
- `auth.jwt_validator`
- `api.rate_limiter`
- `testing.docker_vm_harness`
- `registry.module_indexer`

### Rules
- Lowercase only
- Underscores within segments (not hyphens)
- Exactly one dot separating domain and capability
- Pattern: `^[a-z0-9_]+\.[a-z0-9_]+$`

### Forbidden
- Vague helpers (e.g., `utils.helper`)
- App-specific feature names unless generalized
- Spaces in any part
- Version numbers in module_id (version is a separate field)