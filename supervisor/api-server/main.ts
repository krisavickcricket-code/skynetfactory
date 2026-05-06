/**
 * SkyNetFactory Supervisor - Main Entry Point
 * Orchestrates the module-builder pipeline from contract submission to verified registration.
 */

import { startApiServer } from './server.js';
import { runStartupProbes, startRuntimeProbes, onHealthChange, getHealthSummary } from './health-checks.js';
import { startDeadlockDetection, stopDeadlockDetection } from './lock-manager.js';
import { startCircuitBreakerChecks, stopCircuitBreakerChecks, onCircuitBreakerChange, canDispatch, recordGlobalFailure, recordSuccess } from './circuit-breaker.js';
import { getConfig, reloadConfig } from './config.js';
import { loadContract, loadState, transitionContract, listAllContracts, saveState, createStateFile } from './state-machine.js';
import { acquireLock, releaseLock } from './lock-manager.js';
import { ensureWorktree, scaffoldModule, commitAndTag, rollbackWorktree, commitAndTag as snapshotWorktree, copyToProduction, tagVerified, preserveFailedAttempt } from './rollback.js';
import { runAllGates } from './gate-runner.js';
import { register as registryRegister, computeContractHash } from './registry.js';
import { buildTaskPacket, getCurrentModel, executeWorker, contractToPrompt } from './ollama-adapter.js';
import { contractToAgentSwarmTask, submitTaskToAgentSwarm, isAgentSwarmAvailable } from '../../supervisor/module-builder/agent-swarm-adapter.js';
import { watch } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PENDING_DIR = 'C:/SkynetFactory/module-contracts/pending';

async function main() {
  console.log('[SkyNetFactory] Starting supervisor...');

  // Load configuration
  const config = getConfig();
  console.log(`[SkyNetFactory] Configuration loaded. Default model: ${config.default_ollama_model}`);

  // Run startup health probes
  console.log('[SkyNetFactory] Running startup health probes...');
  const { healthy, statuses } = await runStartupProbes();
  for (const s of statuses) {
    console.log(`[SkyNetFactory] Health ${s.component}: ${s.status} - ${s.details}`);
  }

  if (!healthy) {
    console.error('[SkyNetFactory] HALTING: Required health check failed. Ollama not available.');
    console.error('[SkyNetFactory] Ensure Ollama is running before starting SkyNetFactory.');
    process.exit(1);
  }

  // Start runtime probes
  startRuntimeProbes();
  startDeadlockDetection();
  startCircuitBreakerChecks();

  // Watch for health changes
  onHealthChange((healthMap) => {
    console.log('[SkyNetFactory] Health status changed');
    // Could broadcast via WebSocket
  });

  onCircuitBreakerChange((oldState, newState, reason) => {
    console.log(`[SkyNetFactory] Circuit breaker: ${oldState} -> ${newState} (${reason})`);
  });

  // Watch pending directory for new contracts
  console.log('[SkyNetFactory] Watching pending directory for new contracts...');
  try {
    const watcher = watch(PENDING_DIR, { recursive: false }, (eventType, filename) => {
      if (filename && filename.endsWith('.json') && !filename.endsWith('.state.json')) {
        console.log(`[SkyNetFactory] New contract detected: ${filename}`);
        processNewContract(filename.replace('.json', '')).catch(err => {
          console.error(`[SkyNetFactory] Error processing contract: ${err.message}`);
        });
      }
    });
  } catch (err) {
    console.warn('[SkyNetFactory] File watcher not available, contracts must be submitted via API');
  }

  // Periodically scan for pending contracts
  setInterval(async () => {
    if (!canDispatch()) return;
    const contracts = listAllContracts();
    const pending = contracts.filter(c => c.state === 'pending');
    for (const c of pending) {
      try {
        await processNewContract(c.module_id);
      } catch (err: any) {
        console.error(`[SkyNetFactory] Error processing pending contract ${c.module_id}: ${err.message}`);
      }
    }
  }, 10000);

  // Start API server
  console.log('[SkyNetFactory] Starting API server...');
  await startApiServer();

  console.log('[SkyNetFactory] Supervisor ready. Waiting for contracts...');
}

let processing = new Set<string>();

async function processNewContract(moduleId: string): Promise<void> {
  if (processing.has(moduleId)) return;
  processing.add(moduleId);

  try {
    const state = loadState(moduleId);
    if (!state || state.current_state !== 'pending') return;

    // Check if another contract for the same module_id is in claimed/building/testing
    const allContracts = listAllContracts();
    const conflict = allContracts.find(c =>
      c.module_id === moduleId && ['claimed', 'building', 'testing'].includes(c.state)
    );
    if (conflict) return; // Guard condition not met

    // Try to acquire lock
    const lockResult = acquireLock(moduleId, 'supervisor');
    if (!lockResult.success) return; // Lock failed

    try {
      // Transition to claimed
      const claimedState = transitionContract(moduleId, 'claimed', 'supervisor claimed contract');
      console.log(`[SkyNetFactory] Contract ${moduleId} claimed`);

      // Check Ollama health
      const { healthy } = await runStartupProbes().catch(() => ({ healthy: false }));
      if (!healthy) {
        console.warn('[SkyNetFactory] Ollama not healthy, reverting contract to pending');
        transitionContract(moduleId, 'pending', 'Ollama not healthy');
        releaseLock(moduleId);
        return;
      }

      // Load contract
      const contract = loadContract(moduleId);
      if (!contract) throw new Error(`Contract file not found for ${moduleId}`);

      // Transition to building
      const worktreePath = ensureWorktree(moduleId);
      scaffoldModule(moduleId, contract, worktreePath);
      const buildStartTag = commitAndTag(worktreePath, moduleId, state.attempt_count + 1, 'build-start');

      const buildingState = transitionContract(moduleId, 'building', 'Ollama worker starting', {
        attempt_count: state.attempt_count + 1,
        build_start_tag: buildStartTag,
        model_used: getCurrentModel(moduleId),
      } as any);

      console.log(`[SkyNetFactory] Contract ${moduleId} building with model ${getCurrentModel(moduleId)}`);

      // Build task packet and execute worker
      const taskPacket = buildTaskPacket(moduleId, contract);
      const workerResult = await executeWorker(taskPacket, worktreePath);

      // Write worker_result.json to worktree
      writeFileSync(join(worktreePath, 'worker_result.json'), JSON.stringify(workerResult, null, 2));

      // Transition to testing
      transitionContract(moduleId, 'testing', 'worker completed, running gates');
      console.log(`[SkyNetFactory] Contract ${moduleId} testing`);

      // Run gates
      const gateResult = await runAllGates(contract, worktreePath);

      if (gateResult.overall_result === 'pass') {
        // All gates passed!
        recordSuccess();

        // Copy to production
        copyToProduction(moduleId);
        tagVerified(moduleId, contract.version);

        // Register in registry
        const contractContent = readFileSync(join(worktreePath, 'module.contract.json'), 'utf-8');
        const registryEntry = {
          module_id: moduleId,
          version: contract.version,
          category: contract.category,
          capability_type: contract.capability_type,
          path: `C:/SkynetFactory/production-modules/${moduleId}`,
          contract_path: `C:/SkynetFactory/production-modules/${moduleId}/module.contract.json`,
          sidecar_path: `C:/SkynetFactory/production-modules/${moduleId}/module.sidecar.json`,
          status: 'verified' as const,
          contract_hash: computeContractHash(contractContent),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: contract.sidecar_specification?.composition_tags || [],
          acceptance_evidence_path: `C:/SkynetFactory/logs/evidence/${moduleId}/${Date.now()}`,
        };

        registryRegister(registryEntry);
        transitionContract(moduleId, 'completed', 'all gates passed');
        console.log(`[SkyNetFactory] Contract ${moduleId} COMPLETED and registered!`);
      } else {
        // Gate failure
        const currentState = loadState(moduleId)!;
        const newFailureCount = currentState.consecutive_failure_count + 1;

        // Model fallback at threshold 3
        if (newFailureCount >= (config.model_fallback_threshold || 3)) {
          console.warn(`[SkyNetFactory] Model fallback triggered for ${moduleId} (${newFailureCount} consecutive failures)`);
        }

        // Circuit breaker at threshold 5
        if (newFailureCount >= (config.circuit_breaker_trip_after || 5)) {
          recordGlobalFailure(newFailureCount);
        }

        // Check max remediation
        if (currentState.remediation_count >= (config.max_remediation_attempts || 3)) {
          transitionContract(moduleId, 'rejected', `max remediation attempts reached (${currentState.remediation_count})`);
          console.error(`[SkyNetFactory] Contract ${moduleId} REJECTED after ${currentState.remediation_count} remediation attempts`);
        } else {
          // Preserve failed attempt and rollback
          if (currentState.build_start_tag) {
            preserveFailedAttempt(moduleId, currentState.attempt_count, currentState.build_start_tag);
            rollbackWorktree(moduleId, currentState.build_start_tag);
          }

          transitionContract(moduleId, 'remediation', `gate failure: ${gateResult.individual_results.filter(r => r.result === 'fail').map(r => r.gate_name).join(', ')}`, {
            consecutive_failure_count: newFailureCount,
          } as any);
          console.warn(`[SkyNetFactory] Contract ${moduleId} entering remediation (attempt ${currentState.remediation_count + 1})`);
        }
      }
    } finally {
      releaseLock(moduleId);
    }
  } catch (err: any) {
    console.error(`[SkyNetFactory] Error processing ${moduleId}: ${err.message}`);

    // Try to move to remediation on unexpected error
    try {
      const currentState = loadState(moduleId);
      if (currentState && ['claimed', 'building'].includes(currentState.current_state)) {
        transitionContract(moduleId, 'remediation', `unexpected error: ${err.message}`);
      }
    } catch {}
    releaseLock(moduleId);
  } finally {
    processing.delete(moduleId);
  }
}

// Start
main().catch(err => {
  console.error('[SkyNetFactory] Fatal error:', err);
  process.exit(1);
});