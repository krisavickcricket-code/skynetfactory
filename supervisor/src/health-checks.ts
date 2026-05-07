/**
 * Health Check System
 * Startup probes and runtime probes per the authority contract.
 */

import { getConfig, ROOT_DIR } from './config.js';

export interface HealthStatus {
  component: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  details: string;
  checked_at: string;
}

function getStartupProbes() {
  const config = getConfig();
  return [
    {
      name: 'ollama',
      url: config.ollama_host_url || 'http://localhost:11434/api/tags',
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: 5000,
      required: true,
      onFailure: 'halt_with_error',
    },
    {
      name: 'ollama_default_model',
      url: config.ollama_host_url || 'http://localhost:11434/api/tags',
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: 5000,
      required: false,
      onFailure: 'attempt_pull',
    },
    {
      name: 'agent_swarm_api',
      url: config.agent_swarm_api_base_url
        ? `${config.agent_swarm_api_base_url.replace(/\/$/, '')}/health`
        : 'http://localhost:4000/health',
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: 5000,
      required: false,
      onFailure: 'warn',
    },
  ];
}

function getRuntimeProbes() {
  const config = getConfig();
  return [
    { name: 'ollama_heartbeat', url: config.ollama_host_url || 'http://localhost:11434/api/tags', method: 'GET', timeoutMs: 3000 },
    { name: 'agent_swarm_heartbeat', url: config.agent_swarm_api_base_url ? `${config.agent_swarm_api_base_url.replace(/\/$/, '')}/health` : 'http://localhost:4000/health', method: 'GET', timeoutMs: 3000 },
  ];
}

let runtimeInterval: ReturnType<typeof setInterval> | null = null;
const healthHistory: Map<string, HealthStatus> = new Map();
const listeners: Array<(statuses: Map<string, HealthStatus>) => void> = [];

export function onHealthChange(listener: (statuses: Map<string, HealthStatus>) => void): void {
  listeners.push(listener);
}

function emitChange(): void {
  for (const l of listeners) {
    try { l(new Map(healthHistory)); } catch {}
  }
}

async function probeUrl(url: string, method: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: string; data?: any }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await response.json().catch(() => null);
    return { ok: true, status: response.status, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function runStartupProbes(): Promise<{ healthy: boolean; statuses: HealthStatus[] }> {
  const config = getConfig();
  const startupProbes = getStartupProbes();
  const statuses: HealthStatus[] = [];
  let allHealthy = true;

  for (const probe of startupProbes) {
    const result = await probeUrl(probe.url, probe.method, probe.timeoutMs);
    const status: HealthStatus = {
      component: probe.name,
      status: result.ok && result.status === probe.expectedStatus ? 'healthy' : 'unhealthy',
      details: result.ok
        ? `HTTP ${result.status}`
        : `Error: ${result.error || 'unexpected status'}`,
      checked_at: new Date().toISOString(),
    };

    // Special handling for ollama_default_model
    if (probe.name === 'ollama_default_model' && result.ok && result.data) {
      const modelList = result.data?.models?.map((m: any) => m.name) || [];
      const defaultModel = config.default_ollama_model;
      if (!modelList.some((m: string) => m.includes(defaultModel))) {
        status.status = 'degraded';
        status.details = `Default model '${defaultModel}' not found. Available: ${modelList.join(', ')}`;
      }
    }

    if (status.status !== 'healthy' && probe.required) {
      allHealthy = false;
    }

    statuses.push(status);
    healthHistory.set(probe.name, status);
  }

  return { healthy: allHealthy, statuses };
}

export async function runRuntimeProbes(): Promise<Map<string, HealthStatus>> {
  const runtimeProbes = getRuntimeProbes();
  for (const probe of runtimeProbes) {
    const result = await probeUrl(probe.url, probe.method, probe.timeoutMs);
    const status: HealthStatus = {
      component: probe.name,
      status: result.ok ? 'healthy' : 'unhealthy',
      details: result.ok ? `HTTP ${result.status}` : `Error: ${result.error}`,
      checked_at: new Date().toISOString(),
    };

    const prev = healthHistory.get(probe.name);
    healthHistory.set(probe.name, status);

    if (!prev || prev.status !== status.status) {
      emitChange();
    }
  }

  return new Map(healthHistory);
}

export async function runStartupProbesWithRetry(maxRetries: number = 3, delayMs: number = 10000): Promise<{ healthy: boolean; statuses: HealthStatus[] }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await runStartupProbes();
    if (result.healthy) return result;
    if (attempt < maxRetries) {
      console.warn(`[Health] Startup probes failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return runStartupProbes();
}

export function startRuntimeProbes(): void {
  if (runtimeInterval) return;
  const config = getConfig();
  const intervalMs = config.health_check_interval_ms || 30000;

  runtimeInterval = setInterval(async () => {
    await runRuntimeProbes();
  }, intervalMs);

  // Run initial check
  runRuntimeProbes();
}

export function stopRuntimeProbes(): void {
  if (runtimeInterval) {
    clearInterval(runtimeInterval);
    runtimeInterval = null;
  }
}

export function getHealthStatus(): Map<string, HealthStatus> {
  return new Map(healthHistory);
}

export function getHealthSummary(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, val] of healthHistory) {
    result[key] = val;
  }
  return result;
}