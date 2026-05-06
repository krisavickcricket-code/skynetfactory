/**
 * Circuit Breaker System
 * Per the retry_policy: shared consecutive_failure_count drives both model fallback and circuit breaker.
 * Circuit breaker is GLOBAL — stops ALL new task dispatch across ALL modules.
 * Model fallback is per-module.
 */

import { getConfig } from './config.js';

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerData {
  state: CircuitBreakerState;
  failure_count: number;
  last_failure_at: string | null;
  last_trip_at: string | null;
  half_open_attempts: number;
  open_since: string | null;
}

let _breaker: CircuitBreakerData = {
  state: 'closed',
  failure_count: 0,
  last_failure_at: null,
  last_trip_at: null,
  half_open_attempts: 0,
  open_since: null,
};

const listeners: Array<(oldState: CircuitBreakerState, newState: CircuitBreakerState, reason: string) => void> = [];

export function onCircuitBreakerChange(listener: (oldState: CircuitBreakerState, newState: CircuitBreakerState, reason: string) => void): void {
  listeners.push(listener);
}

function emitChange(oldState: CircuitBreakerState, newState: CircuitBreakerState, reason: string): void {
  for (const l of listeners) {
    try { l(oldState, newState, reason); } catch {}
  }
}

export function getCircuitBreakerState(): CircuitBreakerData {
  return { ..._breaker };
}

export function canDispatch(): boolean {
  return _breaker.state === 'closed' || _breaker.state === 'half_open';
}

export function recordGlobalFailure(failureCount: number): void {
  const config = getConfig();
  const tripThreshold = config.circuit_breaker_trip_after || 5;

  _breaker.failure_count = failureCount;
  _breaker.last_failure_at = new Date().toISOString();

  if (failureCount >= tripThreshold && _breaker.state !== 'open') {
    const oldState = _breaker.state;
    _breaker.state = 'open';
    _breaker.last_trip_at = new Date().toISOString();
    _breaker.open_since = new Date().toISOString();
    _breaker.half_open_attempts = 0;
    emitChange(oldState, 'open', `consecutive_failure_count=${failureCount} >= threshold=${tripThreshold}`);
    console.warn(`[CircuitBreaker] TRIPPED: consecutive failures=${failureCount}, threshold=${tripThreshold}`);
  }
}

export function recordSuccess(): void {
  const oldState = _breaker.state;
  _breaker.failure_count = 0;
  _breaker.last_failure_at = null;

  if (oldState !== 'closed') {
    _breaker.state = 'closed';
    _breaker.open_since = null;
    _breaker.half_open_attempts = 0;
    emitChange(oldState, 'closed', 'success recorded, breaker reset');
  }
}

export function tryHalfOpen(): boolean {
  if (_breaker.state !== 'open') return false;

  const config = getConfig();
  const resetAfterMs = config.circuit_breaker_reset_after_ms || 600000;
  const halfOpenAllowed = (config as any).circuit_breaker_half_open_allowed_attempts || 1;

  if (_breaker.open_since) {
    const elapsed = Date.now() - new Date(_breaker.open_since).getTime();
    if (elapsed < resetAfterMs) {
      return false; // Still in open phase
    }
  }

  const oldState = _breaker.state;
  _breaker.state = 'half_open';
  _breaker.half_open_attempts = 0;
  emitChange(oldState, 'half_open', 'reset period elapsed, transitioning to half_open');
  return true;
}

export function recordHalfOpenAttempt(): void {
  if (_breaker.state !== 'half_open') return;
  _breaker.half_open_attempts += 1;
}

export function isHalfOpenAttemptAllowed(): boolean {
  const config = getConfig();
  const maxAttempts = (config as any).circuit_breaker_half_open_allowed_attempts || 1;
  return _breaker.state === 'half_open' && _breaker.half_open_attempts < maxAttempts;
}

export function recordHalfOpenFailure(): void {
  const oldState = _breaker.state;
  _breaker.state = 'open';
  _breaker.open_since = new Date().toISOString();
  emitChange(oldState, 'open', 'half_open probe failed, back to open');
}

// Periodic check to transition from open -> half_open
let checkInterval: ReturnType<typeof setInterval> | null = null;

export function startCircuitBreakerChecks(): void {
  if (checkInterval) return;
  const config = getConfig();
  const intervalMs = Math.min(config.circuit_breaker_reset_after_ms || 600000, 60000);

  checkInterval = setInterval(() => {
    if (_breaker.state === 'open') {
      tryHalfOpen();
    }
  }, intervalMs);
}

export function stopCircuitBreakerChecks(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}