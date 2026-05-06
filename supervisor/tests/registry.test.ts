import { describe, it, expect, beforeEach } from 'vitest';
import { register, lookup, search, deprecate, computeContractHash } from '../src/registry.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_DIR = 'C:/SkynetFactory/registry';
const TEST_MODULE = 'test.test_module';

describe('Registry', () => {
  beforeEach(() => {
    // Clean up test entry
    const entryPath = join(REGISTRY_DIR, `${TEST_MODULE}.json`);
    if (existsSync(entryPath)) rmSync(entryPath);
  });

  it('should register a module entry', () => {
    const entry = {
      module_id: TEST_MODULE,
      version: '0.1.0',
      category: 'test',
      capability_type: 'validator' as const,
      path: `C:/SkynetFactory/production-modules/${TEST_MODULE}`,
      contract_path: `C:/SkynetFactory/production-modules/${TEST_MODULE}/module.contract.json`,
      sidecar_path: `C:/SkynetFactory/production-modules/${TEST_MODULE}/module.sidecar.json`,
      status: 'verified' as const,
      contract_hash: 'abc123',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: ['test'],
      acceptance_evidence_path: '',
    };

    register(entry);
    const found = lookup(TEST_MODULE);
    expect(found).not.toBeNull();
    expect(found!.module_id).toBe(TEST_MODULE);
    expect(found!.status).toBe('verified');
  });

  it('should compute contract hash', () => {
    const hash = computeContractHash('{"test": true}');
    expect(hash).toBeTruthy();
    expect(hash.length).toBe(64); // SHA-256 hex length
  });

  it('should deprecate a module', () => {
    const entry = {
      module_id: TEST_MODULE,
      version: '0.1.0',
      category: 'test',
      capability_type: 'validator' as const,
      path: `C:/SkynetFactory/production-modules/${TEST_MODULE}`,
      contract_path: `C:/SkynetFactory/production-modules/${TEST_MODULE}/module.contract.json`,
      sidecar_path: `C:/SkynetFactory/production-modules/${TEST_MODULE}/module.sidecar.json`,
      status: 'verified' as const,
      contract_hash: 'abc123',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: ['test'],
      acceptance_evidence_path: '',
    };

    register(entry);
    const result = deprecate(TEST_MODULE, 'no longer needed');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('deprecated');
  });
});