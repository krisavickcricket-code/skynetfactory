/**
 * Concurrency Lock Manager
 * Atomic lockfile-based claim mechanism per the authority contract.
 * Uses OS-level exclusive file creation for atomicity.
 */

import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, ROOT_DIR } from './config.js';

const LOCK_DIR = join(ROOT_DIR, 'temp/claims');

export interface LockFile {
  module_id: string;
  worker_id: string;
  claimed_at: string;
  expected_completion_at: string;
  lock_expires_at: string;
}

export function acquireLock(moduleId: string, workerId: string): { success: boolean; lock?: LockFile; reason?: string } {
  const config = getConfig();
  const lockPath = join(LOCK_DIR, `${moduleId}.lock`);

  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });

  const claimedAt = new Date();
  const lockTimeoutMs = config.lock_timeout_ms || 30000;
  const lockExpiresAt = new Date(claimedAt.getTime() + lockTimeoutMs);
  const expectedCompletionAt = new Date(claimedAt.getTime() + (config.worker_timeout_ms || 1800000));

  const lock: LockFile = {
    module_id: moduleId,
    worker_id: workerId,
    claimed_at: claimedAt.toISOString(),
    expected_completion_at: expectedCompletionAt.toISOString(),
    lock_expires_at: lockExpiresAt.toISOString(),
  };

  // Atomic write using exclusive creation — no TOCTOU race
  try {
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' });
    return { success: true, lock };
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Lock file exists — check if it's stale
      try {
        const existing: LockFile = JSON.parse(readFileSync(lockPath, 'utf-8'));
        if (new Date() > new Date(existing.lock_expires_at)) {
          // Stale lock — take it over
          writeFileSync(lockPath, JSON.stringify(lock, null, 2));
          return { success: true, lock };
        }
        return { success: false, reason: `Lock held by ${existing.worker_id}, expires at ${existing.lock_expires_at}` };
      } catch {
        // Corrupted lock file — remove and retry
        unlinkSync(lockPath);
        return acquireLock(moduleId, workerId);
      }
    }
    throw err;
  }
}

export function releaseLock(moduleId: string): boolean {
  const lockPath = join(LOCK_DIR, `${moduleId}.lock`);
  if (existsSync(lockPath)) {
    unlinkSync(lockPath);
    return true;
  }
  return false;
}

export function getLock(moduleId: string): LockFile | null {
  const lockPath = join(LOCK_DIR, `${moduleId}.lock`);
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, 'utf-8'));
}

export function isLocked(moduleId: string): boolean {
  const lock = getLock(moduleId);
  if (!lock) return false;
  return new Date() < new Date(lock.lock_expires_at);
}

// Deadlock detection - periodically scan for stale locks
let deadlockInterval: ReturnType<typeof setInterval> | null = null;

export function startDeadlockDetection(): void {
  const config = getConfig();
  if (deadlockInterval) return;

  deadlockInterval = setInterval(() => {
    if (!existsSync(LOCK_DIR)) return;

    const files = readdirSync(LOCK_DIR).filter((f: string) => f.endsWith('.lock'));
    for (const file of files) {
      const lockP = join(LOCK_DIR, file);
      try {
        const lock: LockFile = JSON.parse(readFileSync(lockP, 'utf-8'));
        if (new Date() > new Date(lock.lock_expires_at)) {
          console.warn(`[DeadlockCheck] Force-releasing stale lock: ${file}`);
          unlinkSync(lockP);
        }
      } catch {
        // Corrupted lock file - remove it
        unlinkSync(lockP);
      }
    }
  }, config.lock_timeout_ms || 60000);
}

export function stopDeadlockDetection(): void {
  if (deadlockInterval) {
    clearInterval(deadlockInterval);
    deadlockInterval = null;
  }
}