import { describe, it, expect } from 'vitest';
import { getCircuitBreakerState, canDispatch, recordGlobalFailure, recordSuccess } from '../src/circuit-breaker.js';

describe('Circuit Breaker', () => {
  it('should start in closed state', () => {
    const state = getCircuitBreakerState();
    expect(state.state).toBe('closed');
  });

  it('should allow dispatch when closed', () => {
    expect(canDispatch()).toBe(true);
  });

  it('should trip to open when failure threshold is reached', () => {
    // Record 5 failures to trip the breaker (threshold = 5)
    for (let i = 0; i < 5; i++) {
      recordGlobalFailure(i + 1);
    }
    const state = getCircuitBreakerState();
    expect(state.state).toBe('open');
    expect(canDispatch()).toBe(false);
  });

  it('should recover to closed on success', () => {
    recordSuccess();
    const state = getCircuitBreakerState();
    expect(state.state).toBe('closed');
    expect(canDispatch()).toBe(true);
  });
});