# SkyNetFactory Quality Bar

Every module that passes through SkyNetFactory must meet these quality thresholds:

## Structural Completeness
- All required files for the module's language variant must exist
- `module.contract.json` valid against `MODULE_CONTRACT_SCHEMA.json`
- `module.sidecar.json` valid against `SIDECAR_SCHEMA.json`

## Test Coverage
- Unit tests: must exit zero
- Contract tests: must exit zero
- Docker tests: `docker-compose.test.yml` must exit zero

## Security
- No writes outside declared `write_scope`
- No forbidden behaviors detected by their declared `detection_method`
- Network egress matches declared `network_requirements`

## Reusability
- Module has clear API boundary
- Dependencies are declared
- Failure modes are documented
- Sidecar is complete and accurate

## Determinism
- Gate results are deterministic (same inputs → same pass/fail)
- The gate engine is the final authority, not the model that generated the code