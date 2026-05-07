/**
 * Contract State Machine
 * Manages the lifecycle of module contracts through state transitions.
 * Follows the contract_lifecycle definition from the authority contract.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getConfig, ROOT_DIR } from './config.js';

export type ContractState = 'pending' | 'claimed' | 'building' | 'testing' | 'completed' | 'remediation' | 'rejected';

const CONTRACT_DIRS: Record<ContractState, string> = {
  pending: join(ROOT_DIR, 'module-contracts/pending'),
  claimed: join(ROOT_DIR, 'module-contracts/claimed'),
  building: join(ROOT_DIR, 'module-contracts/building'),
  testing: join(ROOT_DIR, 'module-contracts/testing'),
  completed: join(ROOT_DIR, 'module-contracts/completed'),
  remediation: join(ROOT_DIR, 'module-contracts/remediation'),
  rejected: join(ROOT_DIR, 'module-contracts/rejected'),
};

// In-memory cache for contract list queries
let _contractIndex: Array<{ module_id: string; state: ContractState }> | null = null;

export function invalidateContractIndex(): void {
  _contractIndex = null;
}

export interface ContractStateFile {
  module_id: string;
  current_state: ContractState;
  attempt_count: number;
  remediation_count: number;
  last_transition_at: string;
  last_worker_id: string | null;
  lock_holder_worker_id: string | null;
  build_start_tag: string | null;
  model_used: string | null;
  consecutive_failure_count: number;
  history: Array<{
    from_state: string;
    to_state: string;
    at: string;
    reason: string;
  }>;
}

const TRANSITIONS: Record<ContractState, { to: ContractState[]; guard?: string; timeout_ms: number | null; on_timeout: string | null; on_enter?: string }> = {
  pending: { to: ['claimed'], guard: 'no concurrent contract for same module_id', timeout_ms: null, on_timeout: null },
  claimed: { to: ['building'], timeout_ms: 300000, on_timeout: 'revert_to_pending_with_log; release lock' },
  building: { to: ['testing', 'remediation'], timeout_ms: 1800000, on_timeout: 'move_to_remediation_with_reason_timeout', on_enter: 'increment attempt_count; snapshot_worktree; record build_start_tag' },
  testing: { to: ['completed', 'remediation'], timeout_ms: 600000, on_timeout: 'move_to_remediation_with_reason_timeout' },
  remediation: { to: ['building', 'rejected'], timeout_ms: null, on_timeout: null, on_enter: 'increment remediation_count; rollback_worktree; preserve_failed_attempt' },
  completed: { to: ['pending'], timeout_ms: null, on_timeout: null, on_enter: 'register module in registry' },
  rejected: { to: ['pending'], timeout_ms: null, on_timeout: null },
};

export function createStateFile(moduleId: string): ContractStateFile {
  return {
    module_id: moduleId,
    current_state: 'pending',
    attempt_count: 0,
    remediation_count: 0,
    last_transition_at: new Date().toISOString(),
    last_worker_id: null,
    lock_holder_worker_id: null,
    build_start_tag: null,
    model_used: null,
    consecutive_failure_count: 0,
    history: [],
  };
}

export function loadState(moduleId: string): ContractStateFile | null {
  for (const dir of Object.values(CONTRACT_DIRS)) {
    const statePath = join(dir, `${moduleId}.state.json`);
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    }
  }
  return null;
}

export function loadContract(moduleId: string): Record<string, unknown> | null {
  for (const dir of Object.values(CONTRACT_DIRS)) {
    const contractPath = join(dir, `${moduleId}.json`);
    if (existsSync(contractPath)) {
      return JSON.parse(readFileSync(contractPath, 'utf-8'));
    }
  }
  return null;
}

export function saveState(state: ContractStateFile): void {
  const dir = CONTRACT_DIRS[state.current_state];
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, `${state.module_id}.state.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function transitionContract(
  moduleId: string,
  toState: ContractState,
  reason: string,
  extras?: Partial<ContractStateFile>
): ContractStateFile {
  const state = loadState(moduleId);
  if (!state) throw new Error(`No state file for module ${moduleId}`);

  const fromState = state.current_state;
  const allowedTransitions = TRANSITIONS[fromState].to;
  if (!allowedTransitions.includes(toState)) {
    throw new Error(`Invalid transition: ${fromState} -> ${toState}. Allowed: ${allowedTransitions.join(', ')}`);
  }

  // Move contract + state files to new directory
  const oldDir = CONTRACT_DIRS[fromState];
  const newDir = CONTRACT_DIRS[toState];

  const contractFile = `${moduleId}.json`;
  const stateFile = `${moduleId}.state.json`;

  const oldContractPath = join(oldDir, contractFile);
  const oldStatePath = join(oldDir, stateFile);
  const newContractPath = join(newDir, contractFile);
  const newStatePath = join(newDir, stateFile);

  // Update state
  const now = new Date().toISOString();
  state.current_state = toState;
  state.last_transition_at = now;
  state.history.push({ from_state: fromState, to_state: toState, at: now, reason });

  // Handle on_enter actions
  if (toState === 'building') {
    state.attempt_count += 1;
    state.build_start_tag = `build-start-${state.attempt_count}-${Date.now()}`;
  }
  if (toState === 'remediation') {
    state.remediation_count += 1;
  }
  if (toState === 'completed') {
    state.consecutive_failure_count = 0;
  }

  // Apply extras
  if (extras) {
    Object.assign(state, extras);
  }

  // Ensure target directory exists
  mkdirSync(newDir, { recursive: true });

  // Move files atomically
  if (existsSync(oldContractPath) && oldDir !== newDir) {
    renameSync(oldContractPath, newContractPath);
  }
  // Write updated state to new location
  writeFileSync(newStatePath, JSON.stringify(state, null, 2));
  // Remove old state file if different directory
  if (oldDir !== newDir && existsSync(oldStatePath)) {
    unlinkSync(oldStatePath);
  }

  invalidateContractIndex();
  return state;
}

export function canTransition(moduleId: string, toState: ContractState): boolean {
  const state = loadState(moduleId);
  if (!state) return false;

  const allowed = TRANSITIONS[state.current_state]?.to || [];
  return allowed.includes(toState);
}

export function listContractsByState(state: ContractState): string[] {
  const dir = CONTRACT_DIRS[state];
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json') && !f.endsWith('.state.json'))
    .map((f: string) => f.replace('.json', ''));
}

export function listAllContracts(): Array<{ module_id: string; state: ContractState }> {
  if (_contractIndex) return _contractIndex;
  const result: Array<{ module_id: string; state: ContractState }> = [];
  for (const [state, dir] of Object.entries(CONTRACT_DIRS)) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.state.json'));
    for (const f of files) {
      result.push({ module_id: f.replace('.json', ''), state: state as ContractState });
    }
  }
  _contractIndex = result;
  return result;
}