import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStateFile, loadState, saveState, canTransition } from '../src/state-machine.js';
import { acquireLock, releaseLock, isLocked } from '../src/lock-manager.js';

const TEST_MODULE = 'test.sample_module';

describe('State Machine', () => {
  it('should create a valid initial state', () => {
    const state = createStateFile(TEST_MODULE);
    expect(state.module_id).toBe(TEST_MODULE);
    expect(state.current_state).toBe('pending');
    expect(state.attempt_count).toBe(0);
    expect(state.remediation_count).toBe(0);
    expect(state.consecutive_failure_count).toBe(0);
    expect(state.history).toEqual([]);
  });

  it('should save and load state', () => {
    const state = createStateFile(TEST_MODULE);
    saveState(state);
    const loaded = loadState(TEST_MODULE);
    expect(loaded).not.toBeNull();
    expect(loaded!.module_id).toBe(TEST_MODULE);
  });
});

describe('Lock Manager', () => {
  beforeEach(() => {
    releaseLock(TEST_MODULE);
  });

  it('should acquire a lock successfully', () => {
    const result = acquireLock(TEST_MODULE, 'test-worker-01');
    expect(result.success).toBe(true);
    expect(result.lock).toBeDefined();
    expect(result.lock!.module_id).toBe(TEST_MODULE);
    expect(result.lock!.worker_id).toBe('test-worker-01');
  });

  it('should fail to acquire an existing lock', () => {
    acquireLock(TEST_MODULE, 'test-worker-01');
    const result = acquireLock(TEST_MODULE, 'test-worker-02');
    expect(result.success).toBe(false);
  });

  it('should release a lock', () => {
    acquireLock(TEST_MODULE, 'test-worker-01');
    expect(isLocked(TEST_MODULE)).toBe(true);
    releaseLock(TEST_MODULE);
    expect(isLocked(TEST_MODULE)).toBe(false);
  });

  afterEach(() => {
    releaseLock(TEST_MODULE);
  });
});