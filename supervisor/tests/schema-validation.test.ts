import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { compileModuleContractValidator, compileSidecarValidator } from '../src/schema-validation.js';

describe('Schema validation', () => {
  it('compiles the module contract schema with referenced schemas', async () => {
    const validate = await compileModuleContractValidator();
    const contract = JSON.parse(
      readFileSync(join(ROOT_DIR, 'module-contracts/_instructions/EXAMPLES/storage.integrity_verifier.json'), 'utf-8')
    );

    expect(validate(contract)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('compiles the sidecar schema validator', async () => {
    const validate = await compileSidecarValidator();
    const contract = JSON.parse(
      readFileSync(join(ROOT_DIR, 'module-contracts/_instructions/EXAMPLES/storage.integrity_verifier.json'), 'utf-8')
    );

    expect(validate(contract.sidecar_specification)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
