/**
 * SkyNetFactory Supervisor API Server
 * REST + WebSocket API per authority contract supervisor_api_server spec.
 * Fastify-based, localhost only (127.0.0.1), port 3013.
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, ROOT_DIR } from '../src/config.js';
import {
  ContractState, createStateFile, loadState, saveState, loadContract,
  transitionContract, canTransition, listAllContracts
} from '../src/state-machine.js';
import { acquireLock, releaseLock, isLocked } from '../src/lock-manager.js';
import { runAllGates } from '../src/gate-runner.js';
import { register, lookup, search, deprecate, supersede, getRegistryIndex, computeContractHash } from '../src/registry.js';
import { ensureWorktree, scaffoldModule, commitAndTag, copyToProduction, tagVerified } from '../src/rollback.js';
import { buildTaskPacket, contractToPrompt, deriveWriteScope, getCurrentModel } from '../src/ollama-adapter.js';
import { contractToAgentSwarmTask, submitTaskToAgentSwarm, isAgentSwarmAvailable } from '../module-builder/agent-swarm-adapter.js';
import { getHealthSummary } from '../src/health-checks.js';
import { getCircuitBreakerState, onCircuitBreakerChange } from '../src/circuit-breaker.js';
import { RegistryEntry } from '../src/registry.js';
import { compileModuleContractValidator, formatSchemaErrors } from '../src/schema-validation.js';

const ROOT = ROOT_DIR;
const PORT = 3013;

// WebSocket connections
const wsClients: Set<any> = new Set();

function broadcastWsEvent(eventType: string, payload: Record<string, unknown>): void {
  const message = JSON.stringify({ type: eventType, ...payload, timestamp: new Date().toISOString() });
  for (const client of wsClients) {
    try { client.send(message); } catch {}
  }
}

export async function createApiServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: 'info' },
  });

  await app.register(websocket);

  // WebSocket endpoint
  app.get('/skynetfactory/events', { websocket: true }, (connection, req) => {
    wsClients.add(connection.socket);
    connection.socket.on('close', () => wsClients.delete(connection.socket));

    // Send initial state
    connection.socket.send(JSON.stringify({
      type: 'connected',
      contracts: listAllContracts(),
      timestamp: new Date().toISOString(),
    }));
  });

  // Security headers and CORS
  app.addHook('onRequest', async (request, reply) => {
    // Reject non-localhost origins
    const origin = request.headers.origin;
    if (origin && !origin.includes('127.0.0.1') && !origin.includes('localhost')) {
      reply.code(403).send({ status: 'error', error: { code: 'FORBIDDEN', message: 'Origin not allowed' } });
      return;
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
  });

  // Bind to localhost only
  // (handled by the listen call)

  // === REST ENDPOINTS ===

  // GET /contracts - List all contracts
  app.get('/skynetfactory/api/contracts', async (request, reply) => {
    const state = (request.query as any).state as ContractState | undefined;
    const contracts = listAllContracts();
    const filtered = state ? contracts.filter(c => c.state === state) : contracts;

    // Augment with state details
    const result = filtered.map(c => {
      const contractState = loadState(c.module_id);
      return { ...c, state_details: contractState };
    });

    return { status: 'success', data: result };
  });

  // GET /contracts/:moduleId - Contract detail
  app.get('/skynetfactory/api/contracts/:moduleId', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const contract = loadContract(moduleId);
    const state = loadState(moduleId);

    if (!contract && !state) {
      reply.code(404);
      return { status: 'error', error: { code: 'MODULE_NOT_FOUND', message: `Contract ${moduleId} not found` } };
    }

    return { status: 'success', data: { contract, state } };
  });

  // POST /contracts/validate — Pre-flight validation without submitting
  app.post('/skynetfactory/api/contracts/validate', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const moduleId = body.module_id as string;

    if (!moduleId) {
      reply.code(400);
      return { status: 'error', error: { code: 'INVALID_CONTRACT', message: 'module_id is required' } };
    }

    const errors: string[] = [];

    try {
      const validate = await compileModuleContractValidator();
      if (!validate(body)) {
        errors.push(...formatSchemaErrors(validate.errors));
      }
    } catch (err: any) {
      errors.push(`Schema validation error: ${err.message}`);
    }

    if (errors.length > 0) {
      reply.code(422);
      return { status: 'error', valid: false, errors };
    }

    return { status: 'success', valid: true, module_id: moduleId };
  });

  // POST /contracts - Submit new contract
  app.post('/skynetfactory/api/contracts', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const moduleId = body.module_id as string;

    if (!moduleId) {
      reply.code(400);
      return { status: 'error', error: { code: 'INVALID_CONTRACT', message: 'module_id is required' } };
    }

    // Validate no duplicate in active states
    const existing = listAllContracts();
    const activeExisting = existing.find(c =>
      c.module_id === moduleId && ['claimed', 'building', 'testing'].includes(c.state)
    );
    if (activeExisting) {
      reply.code(409);
      return { status: 'error', error: { code: 'CLAIM_CONFLICT', message: `Contract ${moduleId} already in ${activeExisting.state}` } };
    }

    // Validate against schema
    try {
      const validate = await compileModuleContractValidator();
      if (!validate(body)) {
        reply.code(422);
        return { status: 'error', error: { code: 'CONTRACT_SCHEMA_INVALID', message: JSON.stringify(validate.errors) } };
      }
    } catch (err: any) {
      // If validation fails, still accept but log
      console.warn(`[API] Schema validation error: ${err.message}`);
    }

    // Write contract file
    const pendingDir = join(ROOT_DIR, 'module-contracts/pending');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, `${moduleId}.json`), JSON.stringify(body, null, 2));

    // Create state file
    const state = createStateFile(moduleId);
    writeFileSync(join(pendingDir, `${moduleId}.state.json`), JSON.stringify(state, null, 2));

    reply.code(201);
    broadcastWsEvent('contract_state_changed', { module_id: moduleId, from_state: '', to_state: 'pending', reason: 'new contract submitted' });
    return { status: 'success', data: { module_id: moduleId, state: 'pending' } };
  });

  // PUT /contracts/:moduleId/retry - Retry a failed/rejected contract
  app.put('/skynetfactory/api/contracts/:moduleId/retry', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const state = loadState(moduleId);

    if (!state) {
      reply.code(404);
      return { status: 'error', error: { code: 'MODULE_NOT_FOUND', message: `Contract ${moduleId} not found` } };
    }

    if (!['rejected', 'remediation'].includes(state.current_state)) {
      reply.code(400);
      return { status: 'error', error: { code: 'INVALID_STATE', message: `Cannot retry from state ${state.current_state}` } };
    }

    // Reset counters and transition to pending
    state.consecutive_failure_count = 0;
    if (state.current_state === 'rejected') {
      state.attempt_count = 0;
      state.remediation_count = 0;
    }

    try {
      const newState = transitionContract(moduleId, 'pending', 'manual retry', state);
      broadcastWsEvent('contract_state_changed', { module_id: moduleId, from_state: state.current_state, to_state: 'pending', reason: 'manual retry' });
      return { status: 'success', data: newState };
    } catch (err: any) {
      reply.code(400);
      return { status: 'error', error: { code: 'TRANSITION_FAILED', message: err.message } };
    }
  });

  // DELETE /contracts/:moduleId - Cancel a contract
  app.delete('/skynetfactory/api/contracts/:moduleId', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const state = loadState(moduleId);

    if (!state) {
      reply.code(404);
      return { status: 'error', error: { code: 'MODULE_NOT_FOUND', message: `Contract ${moduleId} not found` } };
    }

    if (!['pending', 'claimed'].includes(state.current_state)) {
      reply.code(400);
      return { status: 'error', error: { code: 'INVALID_STATE', message: `Can only cancel from pending or claimed, current: ${state.current_state}` } };
    }

    // Remove contract and state files
    const dir = state.current_state === 'pending'
      ? join(ROOT_DIR, 'module-contracts/pending')
      : join(ROOT_DIR, 'module-contracts/claimed');

    try {
      if (existsSync(join(dir, `${moduleId}.json`))) {
        writeFileSync(join(ROOT_DIR, 'module-contracts/rejected', `${moduleId}.json`), readFileSync(join(dir, `${moduleId}.json`)));
      }
      if (existsSync(join(dir, `${moduleId}.state.json`))) {
        const rejectState = { ...state, current_state: 'rejected' as ContractState };
        mkdirSync(join(ROOT_DIR, 'module-contracts/rejected'), { recursive: true });
        writeFileSync(join(ROOT_DIR, 'module-contracts/rejected', `${moduleId}.state.json`), JSON.stringify(rejectState, null, 2));
      }
      if (existsSync(join(dir, `${moduleId}.json`))) unlinkSync(join(dir, `${moduleId}.json`));
      if (existsSync(join(dir, `${moduleId}.state.json`))) unlinkSync(join(dir, `${moduleId}.state.json`));
    } catch {}

    releaseLock(moduleId);
    broadcastWsEvent('contract_state_changed', { module_id: moduleId, from_state: state.current_state, to_state: 'rejected', reason: 'cancelled' });
    return { status: 'success', data: { module_id: moduleId, state: 'rejected' } };
  });

  // GET /workers - List active workers (stub for now)
  app.get('/skynetfactory/api/workers', async (request, reply) => {
    return { status: 'success', data: { workers: [], active_count: 0 } };
  });

  // GET /gates/:moduleId - Gate results
  app.get('/skynetfactory/api/gates/:moduleId', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const worktreePath = join(ROOT, 'worktrees', moduleId, 'gate_result.json');
    if (!existsSync(worktreePath)) {
      reply.code(404);
      return { status: 'error', error: { code: 'MODULE_NOT_FOUND', message: `No gate results for ${moduleId}` } };
    }
    return { status: 'success', data: JSON.parse(readFileSync(worktreePath, 'utf-8')) };
  });

  // GET /registry - Registry index
  app.get('/skynetfactory/api/registry', async (request, reply) => {
    const index = getRegistryIndex();
    return { status: 'success', data: index };
  });

  // GET /registry/:moduleId - Registry entry detail
  app.get('/skynetfactory/api/registry/:moduleId', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const entry = lookup(moduleId);
    if (!entry) {
      reply.code(404);
      return { status: 'error', error: { code: 'MODULE_NOT_FOUND', message: `Module ${moduleId} not in registry` } };
    }
    return { status: 'success', data: entry };
  });

  // POST /registry/:moduleId/deprecate - Deprecate a module
  app.post('/skynetfactory/api/registry/:moduleId/deprecate', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const { reason } = request.body as { reason?: string };
    const entry = deprecate(moduleId, reason || 'Deprecated by operator');
    if (!entry) {
      reply.code(404);
      return { status: 'error', error: { code: 'MODULE_NOT_FOUND', message: `Module ${moduleId} not in registry` } };
    }
    return { status: 'success', data: entry };
  });

  // GET /logs/:moduleId - Worker and gate logs
  app.get('/skynetfactory/api/logs/:moduleId', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const logDir = join(ROOT, 'logs', moduleId);
    if (!existsSync(logDir)) {
      return { status: 'success', data: { logs: [] } };
    }
    const files = readdirSync(logDir);
    return { status: 'success', data: { logs: files } };
  });

  // GET /evidence/:moduleId - Evidence bundles
  app.get('/skynetfactory/api/evidence/:moduleId', async (request, reply) => {
    const { moduleId } = request.params as { moduleId: string };
    const evidenceDir = join(ROOT, 'logs/evidence', moduleId);
    if (!existsSync(evidenceDir)) {
      return { status: 'success', data: { bundles: [] } };
    }
    const bundles = readdirSync(evidenceDir);
    return { status: 'success', data: { bundles } };
  });

  // GET /health - System health status
  app.get('/skynetfactory/api/health', async (request, reply) => {
    const health = getHealthSummary();
    const breaker = getCircuitBreakerState();
    return {
      status: 'success',
      data: {
        health,
        circuit_breaker: breaker,
      },
    };
  });

  // GET /ollama/models - Proxy to Ollama model list
  app.get('/skynetfactory/api/ollama/models', async (request, reply) => {
    const config = getConfig();
    const ollamaUrl = config.ollama_host_url || 'http://localhost:11434';
    try {
      const response = await fetch(`${ollamaUrl}/api/tags`);
      const data = await response.json();
      return { status: 'success', data };
    } catch (err: any) {
      reply.code(502);
      return { status: 'error', error: { code: 'OLLAMA_UNREACHABLE', message: err.message } };
    }
  });

  // GET /config - Current configuration
  app.get('/skynetfactory/api/config', async (request, reply) => {
    const config = getConfig();
    return { status: 'success', data: config };
  });

  // PUT /config - Update configuration
  app.put('/skynetfactory/api/config', async (request, reply) => {
    const updates = request.body as Record<string, unknown>;
    const configPath = join(ROOT_DIR, 'config/builder.config.json');
    const currentConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const newConfig = { ...currentConfig, ...updates };
    writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

    // Reload config
    const { reloadConfig } = await import('../src/config.js');
    reloadConfig();

    return { status: 'success', data: getConfig() };
  });

  return app;
}

export async function startApiServer(): Promise<void> {
  const app = await createApiServer();

  // Circuit breaker event forwarding
  onCircuitBreakerChange((oldState, newState, reason) => {
    broadcastWsEvent('circuit_breaker_state_changed', { old_state: oldState, new_state: newState, reason });
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`[SkyNetFactory] API server running at http://127.0.0.1:${PORT}`);
  console.log(`[SkyNetFactory] WebSocket at ws://127.0.0.1:${PORT}/skynetfactory/events`);
}
