/**
 * AgentSwarm Adapter
 * Translates SkyNetFactory module contracts to AgentSwarm tasks and
 * manages communication with AgentSwarm's API.
 */

import { readFileSync } from 'node:fs';
import { getConfig } from './config.js';
import { buildTaskPacket, type TaskPacket } from './ollama-adapter.js';

export interface AgentSwarmTask {
  task: string;
  agentId?: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  dir?: string;
  contextKey?: string;
  [key: string]: unknown;
}

/**
 * Translate a SkyNetFactory module contract to an AgentSwarm-compatible task
 */
export function contractToAgentSwarmTask(contract: Record<string, unknown>, taskPacket: TaskPacket): AgentSwarmTask {
  return {
    task: `Implement module ${contract.module_id} v${contract.version}: ${contract.purpose}`,
    tags: [
      'skynetfactory',
      `module:${contract.module_id}`,
      `category:${contract.category}`,
      `capability:${contract.capability_type}`,
      `language:${contract.language}`,
    ],
    priority: 5,
    dir: `C:/SkynetFactory/worktrees/${contract.module_id}`,
    contextKey: `skynetfactory:${contract.module_id}`,
    // AgentSwarm custom fields
    skynetfactory_task_packet: taskPacket,
    skynetfactory_write_scope: taskPacket.write_scope,
    skynetfactory_module_id: contract.module_id,
  };
}

/**
 * Submit a task to AgentSwarm API
 */
export async function submitTaskToAgentSwarm(task: AgentSwarmTask): Promise<{ task_id: string; success: boolean }> {
  const config = getConfig();
  const baseUrl = config.agent_swarm_api_base_url || 'http://localhost:3013';

  try {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.AGENT_SWARM_API_KEY || '',
      },
      body: JSON.stringify(task),
    });

    if (!response.ok) {
      throw new Error(`AgentSwarm API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return { task_id: data.id || data.task_id || 'unknown', success: true };
  } catch (err: any) {
    console.error(`[AgentSwarmAdapter] Failed to submit task: ${err.message}`);
    return { task_id: '', success: false };
  }
}

/**
 * Poll AgentSwarm for task status
 */
export async function pollAgentSwarmTask(taskId: string): Promise<Record<string, unknown> | null> {
  const config = getConfig();
  const baseUrl = config.agent_swarm_api_base_url || 'http://localhost:3013';

  try {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      headers: { 'X-API-Key': process.env.AGENT_SWARM_API_KEY || '' },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Cancel an AgentSwarm task
 */
export async function cancelAgentSwarmTask(taskId: string): Promise<boolean> {
  const config = getConfig();
  const baseUrl = config.agent_swarm_api_base_url || 'http://localhost:3013';

  try {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': process.env.AGENT_SWARM_API_KEY || '' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stream events from AgentSwarm (polling fallback since AgentSwarm may not have websocket push)
 */
export async function* streamTaskEvents(taskId: string): AsyncGenerator<Record<string, unknown>> {
  const config = getConfig();
  const pollInterval = config.poll_interval_ms || 8000;
  let lastStatus = '';

  while (true) {
    const task = await pollAgentSwarmTask(taskId);
    if (task) {
      const status = String(task.status || task.state || '');
      if (status !== lastStatus) {
        lastStatus = status;
        yield {
          type: 'task_status_changed',
          task_id: taskId,
          status,
          data: task,
        };
      }

      // Terminal states
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        return;
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

/**
 * Normalize AgentSwarm task result to worker_result.json format
 */
export function normalizeAgentSwarmResult(taskId: string, taskData: Record<string, unknown>, moduleId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    module_id: moduleId,
    status: taskData.status === 'completed' ? 'passed' : 'failed',
    changed_files: (taskData as any).changed_files || [],
    evidence: {
      model_used: (taskData as any).model || 'agent-swarm-worker',
      prompt_hash: (taskData as any).prompt_hash || '',
      write_scope_declared: (taskData as any).write_scope_declared || [],
      commands_executed: [],
      files_written_log: [],
      duration_ms: (taskData as any).duration_ms || 0,
    },
  };
}

/**
 * Check if AgentSwarm API is available
 */
export async function isAgentSwarmAvailable(): Promise<boolean> {
  const config = getConfig();
  const baseUrl = config.agent_swarm_api_base_url || 'http://localhost:3013';

  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}