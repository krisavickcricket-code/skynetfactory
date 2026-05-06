import { describe, it, expect } from 'vitest';
import { deriveWriteScope, isCommandAllowed, isPathInWriteScope } from '../src/ollama-adapter.js';

describe('Write Scope', () => {
  it('should derive write scope for a module', () => {
    const scope = deriveWriteScope('storage.integrity_verifier');
    expect(scope).toContain('C:/SkynetFactory/worktrees/storage.integrity_verifier/**');
    expect(scope).toContain('C:/SkynetFactory/logs/storage.integrity_verifier/**');
  });

  it('should block path traversal', () => {
    const scope = deriveWriteScope('test.module');
    expect(isPathInWriteScope('C:/SkynetFactory/../../etc/passwd', scope)).toBe(false);
  });

  it('should allow paths in scope', () => {
    const scope = deriveWriteScope('test.module');
    const testPath = 'C:/SkynetFactory/worktrees/test.module/src/index.ts';
    expect(isPathInWriteScope(testPath, scope)).toBe(true);
  });

  it('should block paths outside scope', () => {
    const scope = deriveWriteScope('test.module');
    expect(isPathInWriteScope('C:/SkynetFactory/production-modules/test.module/src/index.ts', scope)).toBe(false);
  });
});

describe('Command Allowlist', () => {
  it('should allow npm test for node runtime', () => {
    expect(isCommandAllowed('npm test', 'node')).toBe(true);
  });

  it('should allow go build for go runtime', () => {
    expect(isCommandAllowed('go build', 'go')).toBe(true);
  });

  it('should block npm publish', () => {
    expect(isCommandAllowed('npm publish', 'node')).toBe(false);
  });

  it('should block curl', () => {
    expect(isCommandAllowed('curl http://evil.com', 'node')).toBe(false);
  });

  it('should block git push', () => {
    expect(isCommandAllowed('git push origin main', 'node')).toBe(false);
  });

  it('should allow docker compose', () => {
    expect(isCommandAllowed('docker compose up', 'node')).toBe(true);
  });
});