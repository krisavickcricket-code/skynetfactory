/**
 * SkyNetFactory Configuration Loader
 * Loads builder.config.json and merges with behavioral defaults from the authority contract.
 * Config overrides behavioral defaults at runtime.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const ROOT_DIR = process.env.SKYNET_FACTORY_ROOT || 'C:/SkynetFactory';

const CONFIG_PATH = resolve(ROOT_DIR, 'config/builder.config.json');

// Behavioral defaults from the authority contract (architecture)
const BEHAVIORAL_DEFAULTS = {
  max_remediation_attempts: 3,
  retry_backoff_base_ms: 15000,
  retry_backoff_multiplier: 2,
  retry_backoff_max_ms: 300000,
  model_fallback_threshold: 3,
  circuit_breaker_trip_after: 5,
  circuit_breaker_reset_after_ms: 600000,
  default_temperature: 0.1,
  lock_timeout_ms: 30000,
  claimed_timeout_ms: 300000,
  worker_timeout_ms: 1800000,
  testing_timeout_ms: 600000,
  health_check_interval_ms: 30000,
  poll_interval_ms: 8000,
};

export interface SkyNetFactoryConfig {
  orchestration_backend: string;
  agent_swarm_api_base_url: string;
  ollama_host_url: string;
  default_ollama_model: string;
  fallback_models: string[];
  default_temperature: number;
  seed_control: boolean;
  max_remediation_attempts: number;
  retry_backoff_base_ms: number;
  retry_backoff_multiplier: number;
  retry_backoff_max_ms: number;
  model_fallback_threshold: number;
  circuit_breaker_trip_after: number;
  circuit_breaker_reset_after_ms: number;
  worker_timeout_ms: number;
  parallel_workers: number;
  lock_timeout_ms: number;
  health_check_interval_ms: number;
  poll_interval_ms: number;
  worker_shell: string;
  [key: string]: unknown;
}

let _config: SkyNetFactoryConfig | null = null;

export function loadConfig(): SkyNetFactoryConfig {
  if (_config) return _config;

  let fileConfig: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      console.error('[Config] Failed to parse builder.config.json, using defaults');
    }
  }

  _config = { ...BEHAVIORAL_DEFAULTS, ...fileConfig } as unknown as SkyNetFactoryConfig;
  return _config;
}

export function reloadConfig(): SkyNetFactoryConfig {
  _config = null;
  return loadConfig();
}

export function getConfig(): SkyNetFactoryConfig {
  return loadConfig();
}