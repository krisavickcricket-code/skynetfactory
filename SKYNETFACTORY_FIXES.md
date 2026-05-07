# SkyNetFactory — Authoritative Fix Specification

**Version:** 1.0  
**Date:** 2026-05-07  
**Scope:** All HIGH, MEDIUM, and LOW issues from the full repo audit  

---

## §1  Configuration — Make ROOT_DIR Portable

Every module hardcodes `C:/SkynetFactory`. This breaks on any other machine and makes testing impossible. Introduce a single `ROOT_DIR` export from `config.ts` and consume it everywhere.

### File: `supervisor/src/config.ts`

```ts
// ADD this export at module scope, after BEHAVIORAL_DEFAULTS:
export const ROOT_DIR = process.env.SKYNET_FACTORY_ROOT || 'C:/SkynetFactory';

// CHANGE the CONFIG_PATH line from:
// const CONFIG_PATH = resolve('C:/SkynetFactory/config/builder.config.json');
// TO:
const CONFIG_PATH = resolve(ROOT_DIR, 'config/builder.config.json');
```

All other files replace their hardcoded `C:/SkynetFactory` with an import of `ROOT_DIR` from `./config.js` (or `../config.js` for api-server / module-builder).

---

## §2  State Machine — Replace require() with ESM imports; mkdir before write

### File: `supervisor/src/state-machine.ts`

**2a.** Replace the hardcoded `ROOT` with the config export:

```ts
// REMOVE:  const ROOT = 'C:/SkynetFactory';
// ADD:
import { ROOT_DIR } from './config.js';

// CHANGE CONTRACT_DIRS to use ROOT_DIR:
const CONTRACT_DIRS: Record<ContractState, string> = {
  pending: join(ROOT_DIR, 'module-contracts/pending'),
  claimed: join(ROOT_DIR, 'module-contracts/claimed'),
  building: join(ROOT_DIR, 'module-contracts/building'),
  testing: join(ROOT_DIR, 'module-contracts/testing'),
  completed: join(ROOT_DIR, 'module-contracts/completed'),
  remediation: join(ROOT_DIR, 'module-contracts/remediation'),
  rejected: join(ROOT_DIR, 'module-contracts/rejected'),
};
```

**2b.** Fix `saveState` to mkdir before write (prevents ENOENT on first run):

```ts
export function saveState(state: ContractStateFile): void {
  const dir = CONTRACT_DIRS[state.current_state];
  mkdirSync(dir, { recursive: true });                          // ← ADD
  const statePath = join(dir, `${state.module_id}.state.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
```

**2c.** Fix `transitionContract` to mkdir the target directory before writing:

```ts
// After the line "const newDir = CONTRACT_DIRS[toState];" ADD:
mkdirSync(newDir, { recursive: true });
```

**2d.** Replace `require('fs')` calls in `listContractsByState` and `listAllContracts`. The `readdirSync` function is already imported at the top of the file (it isn't currently — add it):

```ts
// ADD to the existing import line from 'node:fs':
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
```

Then replace both functions:

```ts
export function listContractsByState(state: ContractState): string[] {
  const dir = CONTRACT_DIRS[state];
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json') && !f.endsWith('.state.json'))
    .map((f: string) => f.replace('.json', ''));
}

export function listAllContracts(): Array<{ module_id: string; state: ContractState }> {
  const result: Array<{ module_id: string; state: ContractState }> = [];
  for (const [state, dir] of Object.entries(CONTRACT_DIRS)) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.state.json'));
    for (const f of files) {
      result.push({ module_id: f.replace('.json', ''), state: state as ContractState });
    }
  }
  return result;
}
```

---

## §3  Lock Manager — Replace require(); fix race condition; use ROOT_DIR

### File: `supervisor/src/lock-manager.ts`

**3a.** Replace hardcoded path with config import:

```ts
// REMOVE:  const LOCK_DIR = 'C:/SkynetFactory/temp/claims';
// ADD:
import { ROOT_DIR } from './config.js';

const LOCK_DIR = join(ROOT_DIR, 'temp/claims');
```

(`join` is already imported.)

**3b.** Replace `require('fs')` in `startDeadlockDetection` with the already-imported `readdirSync`:

```ts
// ADD readdirSync to the import line:
import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

// REPLACE the deadlock detection interval body:
export function startDeadlockDetection(): void {
  const config = getConfig();
  if (deadlockInterval) return;

  deadlockInterval = setInterval(() => {
    if (!existsSync(LOCK_DIR)) return;

    const files = readdirSync(LOCK_DIR).filter((f: string) => f.endsWith('.lock'));
    for (const file of files) {
      const lockPath = join(LOCK_DIR, file);
      try {
        const lock: LockFile = JSON.parse(readFileSync(lockPath, 'utf-8'));
        if (new Date() > new Date(lock.lock_expires_at)) {
          console.warn(`[DeadlockCheck] Force-releasing stale lock: ${file}`);
          unlinkSync(lockPath);
        }
      } catch {
        unlinkSync(lockPath);
      }
    }
  }, config.lock_timeout_ms || 60000);
}
```

**3c.** Fix the TOCTOU race condition in `acquireLock`. Remove the `existsSync` check before write; let the `wx` flag handle it atomically. Then check for stale locks only on EEXIST:

```ts
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

  try {
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' });
    return { success: true, lock };
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Lock exists — check if it's stale
      try {
        const existing: LockFile = JSON.parse(readFileSync(lockPath, 'utf-8'));
        if (new Date() > new Date(existing.lock_expires_at)) {
          // Stale lock — take it over (overwrite)
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
```

*(Remove the entire old preamble of existsSync + readSync + unlinkSync.)*

---

## §4  Registry — Use ROOT_DIR; replace require('node:fs').renameSync

### File: `supervisor/src/registry.ts`

**4a.** Replace hardcoded path:

```ts
// REMOVE:  const REGISTRY_DIR = 'C:/SkynetFactory/registry';
// ADD:
import { ROOT_DIR } from './config.js';

const REGISTRY_DIR = join(ROOT_DIR, 'registry');
```

**4b.** `atomicWrite` uses `require('node:fs').renameSync`. Replace with the already-imported `renameSync`:

```ts
// ADD renameSync to the import from 'node:fs':
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from 'node:fs';

// REPLACE atomicWrite:
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}
```

---

## §5  Gate Runner — Remove @ts-nocheck; use ROOT_DIR; add ajv-formats dep

### File: `supervisor/src/gate-runner.ts`

**5a.** Remove the first line:

```ts
// REMOVE:  // @ts-nocheck
```

**5b.** Replace all hardcoded `C:/SkynetFactory` references with `ROOT_DIR`:

```ts
import { getConfig, ROOT_DIR } from './config.js';

// Inside runContractValidation:
// CHANGE: const schemaPath = 'C:/SkynetFactory/module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json';
// TO:
const schemaPath = join(ROOT_DIR, 'module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json');

// Inside runSidecarValidation:
// CHANGE: const schemaPath = 'C:/SkynetFactory/module-contracts/_instructions/SIDECAR_SCHEMA.json';
// TO:
const schemaPath = join(ROOT_DIR, 'module-contracts/_instructions/SIDECAR_SCHEMA.json');

// Inside runNetworkPolicyValidation — no path changes needed (it uses contract data only).

// Inside runRegistryValidation:
// CHANGE: const registryPath = `C:/SkynetFactory/registry/${moduleId}.json`;
// TO:
const registryPath = join(ROOT_DIR, 'registry', `${moduleId}.json`);

// Inside runAllGates — evidence directory:
// CHANGE: const evidenceDir = `C:/SkynetFactory/logs/evidence/${contract.module_id}/${Date.now()}`;
// TO:
const evidenceDir = join(ROOT_DIR, 'logs/evidence', contract.module_id, String(Date.now()));
```

**5c.** Remove the local `unlinkSync` function at the bottom that uses `require`:

```ts
// REMOVE this entire function:
function unlinkSync(path: string) {
  const { unlinkSync: unlink } = require('node:fs');
  unlink(path);
}
```

The real `unlinkSync` is already imported from `node:fs` at the top. If it's not, add it to the import:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
```

**5d.** Fix Docker test command to be cross-platform:

Inside `runDockerTests`, change:

```ts
// FROM:
const command = `docker compose -f docker-compose.test.yml up --build --abort-on-container-exit 2>nul || docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit`;
// TO (cross-platform stderr suppression):
const command = `docker compose -f docker-compose.test.yml up --build --abort-on-container-exit || docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit`;
```

(Remove the `2>nul` which is Windows-only. The `try/catch` around `execAsync` is sufficient error handling.)

### File: `supervisor/package.json`

**5e.** Add `ajv-formats`:

```json
"dependencies": {
    "ajv-formats": "^3.0.0",
    "fastify": "^5.3.0",
```

---

## §6  Ollama Adapter — Use ROOT_DIR

### File: `supervisor/src/ollama-adapter.ts`

```ts
// ADD to imports:
import { getConfig, ROOT_DIR } from './config.js';

// In deriveWriteScope:
export function deriveWriteScope(moduleId: string): string[] {
  return [
    join(ROOT_DIR, 'worktrees', moduleId) + '/**',
    join(ROOT_DIR, 'logs', moduleId) + '/**',
  ];
}

// In buildTaskPacket:
// CHANGE: production_module_path: `C:/SkynetFactory/production-modules/${moduleId}`,
// TO:
production_module_path: join(ROOT_DIR, 'production-modules', moduleId),

// In contractToPrompt:
// CHANGE: const worktreePath = `C:/SkynetFactory/worktrees/${contract.module_id}`;
// TO:
const worktreePath = join(ROOT_DIR, 'worktrees', String(contract.module_id));
```

---

## §7  Health Checks — Use ROOT_DIR; add startup retry

### File: `supervisor/src/health-checks.ts`

**7a.** Make probe URLs configurable (the Ollama URL already comes from config, but agent_swarm URL doesn't):

```ts
import { getConfig, ROOT_DIR } from './config.js';

// In the startup/runtime probe definitions, replace hardcoded URLs with config-driven ones:
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
        : 'http://localhost:3013/health',
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
    { name: 'agent_swarm_heartbeat', url: config.agent_swarm_api_base_url ? `${config.agent_swarm_api_base_url.replace(/\/$/, '')}/health` : 'http://localhost:3013/health', method: 'GET', timeoutMs: 3000 },
  ];
}
```

Then in `runStartupProbes` and `runRuntimeProbes`, use `getStartupProbes()` and `getRuntimeProbes()` instead of the bare arrays.

**7b.** Add startup retry logic:

```ts
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
```

---

## §8  Rollback — Use ROOT_DIR

### File: `supervisor/src/rollback.ts`

```ts
// REMOVE:  const ROOT = 'C:/SkynetFactory';
// ADD:
import { ROOT_DIR } from './config.js';

// Change all derived constants:
const WORKTREES_DIR = join(ROOT_DIR, 'worktrees');
const PRODUCTION_DIR = join(ROOT_DIR, 'production-modules');
const FAILED_ATTEMPTS_DIR = join(ROOT_DIR, 'logs/failed_attempts');
const EVIDENCE_DIR = join(ROOT_DIR, 'logs/evidence');

// git() calls that reference ROOT also need updating:
// Inside ensureWorktree:
//   const branchExists = gitOrEmpty(`branch --list ${branchName}`, ROOT).length > 0;
//   →  const branchExists = gitOrEmpty(`branch --list ${branchName}`, ROOT_DIR).length > 0;
// And all other ROOT references become ROOT_DIR.
```

---

## §9  API Server — Use ROOT_DIR; fix require(); fix agent-swarm adapter port; add graceful shutdown

### File: `supervisor/api-server/server.ts`

**9a.** Replace hardcoded paths and the `require('fs')` call:

```ts
// ADD at top:
import { ROOT_DIR } from '../config.js';

// CHANGE:  const ROOT = 'C:/SkynetFactory';
// TO:  (removed — ROOT_DIR replaces it)

// CHANGE everywhere ROOT is used:
// const pendingDir = 'C:/SkynetFactory/module-contracts/pending';  →  const pendingDir = join(ROOT_DIR, 'module-contracts/pending');
// dir = 'C:/SkynetFactory/module-contracts/pending'                →  dir = join(ROOT_DIR, 'module-contracts/pending')
// dir = 'C:/SkynetFactory/module-contracts/claimed'                →  join(ROOT_DIR, 'module-contracts/claimed')
// 'C:/SkynetFactory/module-contracts/rejected'                     →  join(ROOT_DIR, 'module-contracts/rejected')
// 'C:/SkynetFactory/module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json' →  join(ROOT_DIR, 'module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json')
// 'C:/SkynetFactory/config/builder.config.json'                    →  join(ROOT_DIR, 'config/builder.config.json')
// worktreePath, logDir, evidenceDir all use ROOT_DIR

// In the DELETE endpoint, replace require('fs'):
// REMOVE:  try { require('fs').unlinkSync(join(dir, `${moduleId}.json`)); } catch {}
// REMOVE:  try { require('fs').unlinkSync(join(dir, `${moduleId}.state.json`)); } catch {}
// ADD (unlinkSync is already imported at the top):
if (existsSync(join(dir, `${moduleId}.json`))) unlinkSync(join(dir, `${moduleId}.json`));
if (existsSync(join(dir, `${moduleId}.state.json`))) unlinkSync(join(dir, `${moduleId}.state.json`));
```

**9b.** Agent-swarm adapter import path fix — the adapter is at `../module-builder/agent-swarm-adapter.ts` relative to `api-server/`, not `../../supervisor/module-builder/agent-swarm-adapter`:

```ts
// CHANGE:
import { contractToAgentSwarmTask, submitTaskToAgentSwarm, isAgentSwarmAvailable } from '../../supervisor/module-builder/agent-swarm-adapter.js';
// TO:
import { contractToAgentSwarmTask, submitTaskToAgentSwarm, isAgentSwarmAvailable } from '../module-builder/agent-swarm-adapter.js';
```

### File: `supervisor/api-server/main.ts`

**9c.** Same import path fix:

```ts
// CHANGE:
import { contractToAgentSwarmTask, submitTaskToAgentSwarm, isAgentSwarmAvailable } from '../../supervisor/module-builder/agent-swarm-adapter.js';
// TO:
import { contractToAgentSwarmTask, submitTaskToAgentSwarm, isAgentSwarmAvailable } from '../module-builder/agent-swarm-adapter.js';
```

**9d.** Replace hardcoded `C:/SkynetFactory` in `main.ts`:

```ts
// ADD:
import { ROOT_DIR } from './config.js';
import { stopRuntimeProbes } from './health-checks.js';
import { stopCircuitBreakerChecks } from './circuit-breaker.js';
import { stopDeadlockDetection } from './lock-manager.js';

// CHANGE:  const PENDING_DIR = 'C:/SkynetFactory/module-contracts/pending';
// TO:       const PENDING_DIR = join(ROOT_DIR, 'module-contracts/pending');

// In processNewContract — production module paths:
// CHANGE:  path: `C:/SkynetFactory/production-modules/${moduleId}`,
// TO:       path: join(ROOT_DIR, 'production-modules', moduleId),
// and all similar paths

// REMOVE:  import { commitAndTag as snapshotWorktree, ... } (duplicate alias)
// KEEP:    import { ensureWorktree, scaffoldModule, commitAndTag, rollbackWorktree, copyToProduction, tagVerified, preserveFailedAttempt } from './rollback.js';
```

**9e.** Add graceful shutdown:

```ts
// ADD at bottom of main(), before the closing:

function gracefulShutdown() {
  console.log('[SkyNetFactory] Shutting down gracefully...');
  stopCircuitBreakerChecks();
  stopDeadlockDetection();
  stopRuntimeProbes();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
```

**9f.** Use startup retry in main:

```ts
// CHANGE:
const { healthy, statuses } = await runStartupProbes();
// TO:
const { healthy, statuses } = await runStartupProbesWithRetry(3, 10000);
```

Add import:

```ts
import { runStartupProbes, runStartupProbesWithRetry, startRuntimeProbes, onHealthChange, getHealthSummary } from './health-checks.js';
```

---

## §10  Agent-Swarm Adapter — Fix import paths; fix port collision; use ROOT_DIR

### File: `supervisor/module-builder/agent-swarm-adapter.ts`

```ts
// CHANGE:  import { getConfig } from './config.js';
// TO:      import { getConfig } from '../src/config.js';
// Because this file is in module-builder/, one level up from src/

// CHANGE:  import { buildTaskPacket, type TaskPacket } from './ollama-adapter.js';
// TO:      import { buildTaskPacket, type TaskPacket } from '../src/ollama-adapter.js';

// In contractToAgentSwarmTask:
// CHANGE:  dir: `C:/SkynetFactory/worktrees/${contract.module_id}`,
// TO:
import { ROOT_DIR } from '../src/config.js';
// ...
dir: join(ROOT_DIR, 'worktrees', String(contract.module_id)),
```

(`join` must be imported from `node:path`.)

Also, the default `agent_swarm_api_base_url` must NOT be port 3013 (which is the supervisor's own port). Change the config default:

### File: `config/builder.config.json`

```json
"agent_swarm_api_base_url": "http://localhost:4000",
```

This avoids collision with the supervisor API on 3013. The `agent_swarm_health` probe in `health-checks.ts` already uses `config.agent_swarm_api_base_url`.

---

## §11  tsconfig — Include api-server and module-builder

### File: `supervisor/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "api-server/**/*", "module-builder/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

Key changes: `rootDir` moved from `src` to `.`  so `api-server/` and `module-builder/` compile. `include` expanded. `tests` added to exclude.

---

## §12  package.json — Fix start/dev scripts; add missing dep

### File: `supervisor/package.json`

```json
{
  "name": "skynetfactory-supervisor",
  "version": "1.4.0",
  "description": "SkyNetFactory module-builder supervisor",
  "type": "module",
  "main": "dist/api-server/main.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch api-server/main.ts",
    "start": "node dist/api-server/main.js",
    "test": "vitest run"
  },
  "dependencies": {
    "ajv-formats": "^3.0.0",
    "fastify": "^5.3.0",
    "@fastify/websocket": "^11.0.0",
    "chokidar": "^4.0.0",
    "ajv": "^8.17.0",
    "uuid": "^10.0.0",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0",
    "vitest": "^3.0.0"
  }
}
```

Changes:
- Added `"main": "dist/api-server/main.js"`
- Fixed `"dev"` and `"start"` to point to `api-server/main.ts` / `.js`
- Added `"ajv-formats"` to dependencies

---

## §13  Worker Runtime — Make paths portable; add engines

### File: `worker-runtime/ollama-worker/src/worker.ts`

**13a.** Replace hardcoded path:

```ts
// CHANGE:  const worktreePath = `C:/SkynetFactory/worktrees/${taskPacket.module_id}`;
// TO:
const SKYNET_ROOT = process.env.SKYNET_FACTORY_ROOT || 'C:/SkynetFactory';
const worktreePath = join(SKYNET_ROOT, 'worktrees', taskPacket.module_id);
```

Add `import { join } from 'node:path';` if not already present.

**13b.** Fix the `process.argv[1]` check at the bottom which is unreliable with tsx:

```ts
// REPLACE:
if (process.argv[1]?.includes('worker.ts')) {
  main();
}
// WITH:
main().catch((err) => {
  console.error(`[Worker] Fatal: ${err.message}`);
  process.exit(1);
});
```

### File: `worker-runtime/package.json`

```json
{
  "name": "skynetfactory-ollama-worker",
  "version": "1.4.0",
  "description": "SkyNetFactory Ollama worker - implements modules using local Ollama models",
  "type": "module",
  "main": "dist/worker.js",
  "scripts": {
    "start": "tsx src/worker.ts",
    "build": "tsc"
  },
  "engines": { "node": ">=18.0.0" },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

---

## §14  UI — Replace inline styles with Tailwind classes; fix missing assets

### File: `ui/electron-app/src/App.tsx`

The `index.css` already imports Tailwind (`@import "tailwindcss"`) and defines CSS custom properties. The inline `style={{}}` in `App.tsx` should use these variables via Tailwind utility classes where possible. However, since the UI file is large and functional as-is, this is a **low-priority cosmetic** change. The real fixes are:

**14a.** Make `ROOT_DIR` path visible to the settings view:

In the Settings view, replace the hardcoded `C:/SkynetFactory` reference:

```tsx
<p style={{ color: 'var(--color-text-muted)' }}>
  Configuration is managed by the supervisor at the path specified by the SKYNET_FACTORY_ROOT environment variable 
  (default: <code>C:/SkynetFactory/config/builder.config.json</code>)
</p>
```

**14b.** Create a placeholder icon file:

```bash
mkdir -p ui/electron-app/assets
# Create a simple placeholder PNG (any 256x256 icon will do)
```

### File: `ui/electron-app/electron-builder.js`

Change the icon path reference to not fail if missing:

```js
win: {
    target: 'nsis',
    // Remove icon reference if no icon exists yet
},
```

---

## §15  Main Entry — Fix module path, consolidate imports, remove stale alias

### File: `supervisor/api-server/main.ts` (full corrected version)

This applies all the §9 changes plus the ROOT_DIR propagation throughout `processNewContract`:

Every occurrence of `C:/SkynetFactory/...` in `main.ts` and `server.ts` must be replaced with `join(ROOT_DIR, ...)` or `ROOT_DIR`-relative paths. The key ones:

| Hardcoded | Replacement |
|---|---|
| `'C:/SkynetFactory/module-contracts/pending'` | `join(ROOT_DIR, 'module-contracts/pending')` |
| `'C:/SkynetFactory/worktrees/${moduleId}'` | `join(ROOT_DIR, 'worktrees', moduleId)` |
| `'C:/SkynetFactory/production-modules/${moduleId}'` | `join(ROOT_DIR, 'production-modules', moduleId)` |
| `'C:/SkynetFactory/logs/evidence/${moduleId}/${Date.now()}'` | `join(ROOT_DIR, 'logs/evidence', moduleId, String(Date.now()))` |
| `'C:/SkynetFactory/module-contracts/rejected'` | `join(ROOT_DIR, 'module-contracts/rejected')` |
| `'C:/SkynetFactory/module-contracts/claimed'` | `join(ROOT_DIR, 'module-contracts/claimed')` |
| `'C:/SkynetFactory/module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json'` | `join(ROOT_DIR, 'module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json')` |
| `'C:/SkynetFactory/config/builder.config.json'` | `join(ROOT_DIR, 'config/builder.config.json')` |

---

## §16  Git Worktree — Add startup check

### File: `supervisor/src/rollback.ts`

Add a git-repo initialization check that runs once at startup:

```ts
export function ensureGitRepo(): void {
  if (!existsSync(join(ROOT_DIR, '.git'))) {
    console.warn(`[Rollback] No git repo found at ${ROOT_DIR}. Initializing...`);
    git('init', ROOT_DIR);
    git('checkout -b main', ROOT_DIR);
    // Create initial commit so tags work
    writeFileSync(join(ROOT_DIR, '.gitkeep'), '');
    gitOrEmpty('add .gitkeep', ROOT_DIR);
    gitOrEmpty('commit -m "initial commit" --allow-empty', ROOT_DIR);
  }
}
```

Export it and call it in `main.ts` during startup, after health probes but before the main loop.

---

## §17  In-Memory Contract Index — Avoid directory scans on every request

### File: `supervisor/src/state-machine.ts`

Add a simple in-memory cache that invalidates on state transitions:

```ts
let _contractIndex: Array<{ module_id: string; state: ContractState }> | null = null;

export function invalidateContractIndex(): void {
  _contractIndex = null;
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
```

In `transitionContract`, call `invalidateContractIndex()` at the end. In `main.ts` and `server.ts`, call it after any write operation on contracts.

---

## §18  File Watcher — Prevent double-trigger

### File: `supervisor/api-server/main.ts`

Replace the raw `watch()` with `chokidar` (already in dependencies):

```ts
import chokidar from 'chokidar';

// REPLACE the try/catch watch block:
const watcher = chokidar.watch(PENDING_DIR, { ignoreInitial: true });
watcher.on('add', (filePath) => {
  const filename = path.basename(filePath);
  if (filename.endsWith('.json') && !filename.endsWith('.state.json')) {
    console.log(`[SkyNetFactory] New contract detected: ${filename}`);
    processNewContract(filename.replace('.json', '')).catch(err => {
      console.error(`[SkyNetFactory] Error processing contract: ${err.message}`);
    });
  }
});
watcher.on('error', (err) => {
  console.warn(`[SkyNetFactory] File watcher error: ${err.message}`);
});
```

---

## §19  Worker Result Extraction — Share extraction logic

The supervisor's `ollama-adapter.ts` `executeWorker()` writes raw LLM output to `llm_response.md`. It should also try to extract files like the worker-runtime does.

### File: `supervisor/src/ollama-adapter.ts`

Add a shared extraction function and use it in `executeWorker`:

```ts
interface ExtractedFile {
  path: string;
  content: string;
}

function extractFilesFromResponse(response: string, baseDir: string, writeScope: string[]): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  const fileRegex = /---\s*FILE:\s*(.+?)\s*---\n([\s\S]*?)---\s*END FILE\s*---/g;
  let match;
  while ((match = fileRegex.exec(response)) !== null) {
    const filePath = join(baseDir, match[1].trim());
    const content = match[2];
    if (isPathInWriteScope(filePath, writeScope)) {
      files.push({ path: filePath, content });
    } else {
      console.warn(`[OllamaAdapter] Blocked write outside scope: ${filePath}`);
    }
  }
  return files;
}
```

Then in `executeWorker`, after getting the response, replace the simple `writeFileSync` with:

```ts
const extractedFiles = extractFilesFromResponse(content, worktreePath, taskPacket.write_scope);
const filesWrittenLog: Array<{ path: string; size_bytes: number; sha256: string }> = [];
for (const file of extractedFiles) {
  mkdirSync(join(file.path, '..'), { recursive: true });
  writeFileSync(file.path, file.content);
  filesWrittenLog.push({
    path: file.path,
    size_bytes: Buffer.byteLength(file.content),
    sha256: createHash('sha256').update(file.content).digest('hex'),
  });
}
// Also write full response for debugging:
writeFileSync(join(worktreePath, 'llm_response.md'), content);
```

---

## §20  CORS Restriction on API Server

### File: `supervisor/api-server/server.ts`

Add an origin check on the `onRequest` hook (not `onSend`):

```ts
app.addHook('onRequest', async (request, reply) => {
  // Reject non-localhost origins for security
  const origin = request.headers.origin;
  if (origin && !origin.includes('127.0.0.1') && !origin.includes('localhost')) {
    reply.code(403).send({ status: 'error', error: { code: 'FORBIDDEN', message: 'Origin not allowed' } });
    return;
  }
});
```

---

## §21  .env.example — Document environment variables

### New File: `.env.example`

```
# SkyNetFactory Configuration
# Override the default root directory (default: C:/SkynetFactory on Windows, /opt/skynetfactory on Linux)
SKYNET_FACTORY_ROOT=C:/SkynetFactory

# Ollama API URL (overrides builder.config.json ollama_host_url)
OLLAMA_URL=http://localhost:11434

# AgentSwarm API URL (overrides builder.config.json agent_swarm_api_base_url)
AGENT_SWARM_API_URL=http://localhost:4000

# AgentSwarm API key (if auth is enabled)
AGENT_SWARM_API_KEY=

# Default temperature (overrides builder.config.json)
DEFAULT_TEMPERATURE=0.1

# Seed control (true/false)
SEED_CONTROL=true
```

---

## §22  Sample Contract — Add missing test fixture

### New File: `module-contracts/pending/test.sample_module.json`

```json
{
  "module_id": "test.sample_module",
  "version": "0.1.0",
  "category": "test",
  "capability_type": "validator",
  "purpose": "A sample module contract used for integration testing of the SkyNetFactory pipeline",
  "reuse_scope": ["test environments only"],
  "language": "typescript",
  "runtime": "node",
  "api": {
    "endpoints": [
      { "method": "GET", "path": "/health", "description": "Health check" }
    ]
  },
  "dependencies": [],
  "sidecar_specification": {
    "purpose": "Test module for pipeline validation",
    "agent_usage": {
      "when_to_use": "Never in production — for testing only",
      "when_not_to_use": "Any production scenario"
    },
    "common_calls": [
      { "description": "Health check", "method": "GET", "path_or_command": "/health" }
    ],
    "failure_modes": [
      { "condition": "Service down", "symptom": "Non-200 response", "recovery": "Restart the service" }
    ],
    "composition_tags": ["test", "validator"]
  },
  "acceptance_gates": ["structure_validation", "contract_validation"],
  "vm_test_requirements": {
    "dockerfile_required": false,
    "compose_required": false,
    "must_exit_zero": true
  },
  "forbidden_behaviors": [],
  "network_requirements": {
    "requires_network": false,
    "allow_localhost": true
  },
  "agent_notes": {
    "implementation_hint": "Keep it minimal — this is a test fixture",
    "known_gotchas": "None"
  }
}
```

---

## §23  README.md — Add top-level project documentation

### New File: `README.md`

````markdown
# SkyNetFactory

Automated module generation pipeline: from contract specification to verified, registered, production-ready code.

## Architecture

- **Supervisor** (`supervisor/`) — TypeScript/Node orchestrator that manages the contract lifecycle, gate runner, circuit breaker, lock manager, registry, and REST+WebSocket API.
- **Worker Runtime** (`worker-runtime/`) — Standalone Ollama worker that receives task packets, calls LLMs, enforces write scope/command allowlist, and produces `worker_result.json`.
- **UI** (`ui/electron-app/`) — Electron + React dashboard for live pipeline visibility.
- **Agent Swarm** (`orchestration/agent-swarm/`) — Existing orchestration system that SkyNetFactory reuses for task dispatch.

## Quick Start

```bash
# 1. Set the root directory (optional, defaults to C:/SkynetFactory on Windows)
export SKYNET_FACTORY_ROOT=/opt/skynetfactory  # Linux/macOS
set SKYNET_FACTORY_ROOT=C:\SkynetFactory        # Windows

# 2. Install supervisor dependencies
cd supervisor && npm install

# 3. Build
npm run build

# 4. Ensure Ollama is running
ollama serve

# 5. Start the supervisor
npm run dev
```

## Configuration

See `config/builder.config.json` for all runtime-overridable settings. Key settings:

| Setting | Default | Description |
|---|---|---|
| `ollama_host_url` | `http://localhost:11434` | Ollama API endpoint |
| `default_ollama_model` | `qwen3-coder` | Primary model |
| `agent_swarm_api_base_url` | `http://localhost:4000` | AgentSwarm API (port 4000, not 3013) |
| `max_remediation_attempts` | 3 | Max retry cycles before rejection |
| `circuit_breaker_trip_after` | 5 | Global failure threshold to stop dispatch |

## Environment Variables

See `.env.example` for the full list.

## Running Tests

```bash
cd supervisor && npm test
```

## License

Proprietary — internal use only.
````

---

## Change Summary Table

| § | Severity | File(s) | Fix |
|---|---|---|---|
| 1 | CRITICAL | `config.ts` + 8 files | ROOT_DIR env var instead of hardcoded paths |
| 2a | CRITICAL | `state-machine.ts` | Use ROOT_DIR for CONTRACT_DIRS |
| 2b | HIGH | `state-machine.ts` | mkdirSync before state file writes |
| 2c | HIGH | `state-machine.ts` | mkdirSync before transition target |
| 2d | CRITICAL | `state-machine.ts` | Replace require() with ESM import |
| 3a | HIGH | `lock-manager.ts` | Use ROOT_DIR |
| 3b | CRITICAL | `lock-manager.ts` | Replace require() with ESM import |
| 3c | CRITICAL | `lock-manager.ts` | Fix TOCTOU race in acquireLock |
| 4a | HIGH | `registry.ts` | Use ROOT_DIR |
| 4b | HIGH | `registry.ts` | Replace require().renameSync |
| 5a | CRITICAL | `gate-runner.ts` | Remove @ts-nocheck |
| 5b | HIGH | `gate-runner.ts` | Use ROOT_DIR for schema paths |
| 5c | HIGH | `gate-runner.ts` | Remove require()-based unlinkSync |
| 5d | MEDIUM | `gate-runner.ts` | Cross-platform docker compose cmd |
| 5e | CRITICAL | `package.json` | Add ajv-formats dependency |
| 6 | HIGH | `ollama-adapter.ts` | Use ROOT_DIR |
| 7a | HIGH | `health-checks.ts` | Config-driven probe URLs |
| 7b | MEDIUM | `health-checks.ts` | Startup retry logic |
| 8 | HIGH | `rollback.ts` | Use ROOT_DIR |
| 9a-b | CRITICAL | `server.ts`, `main.ts` | Use ROOT_DIR; fix require() |
| 9c | CRITICAL | `main.ts`, `server.ts` | Fix agent-swarm import path |
| 9d | CRITICAL | `main.ts` | Remove duplicate alias |
| 9e | HIGH | `main.ts` | Graceful shutdown |
| 9f | MEDIUM | `main.ts` | Startup probe retry |
| 10 | CRITICAL | `agent-swarm-adapter.ts` | Fix import paths; ROOT_DIR; fix port collision |
| 11 | CRITICAL | `tsconfig.json` | Include api-server/ and module-builder/ |
| 12 | CRITICAL | `package.json` | Fix scripts; add main; add ajv-formats |
| 13a-b | MEDIUM | `worker.ts`, `package.json` | PORTABLE_ROOT; fix entry; add engines |
| 14a-b | LOW | `App.tsx`, `electron-builder.js` | Fix path text; remove missing icon |
| 15 | HIGH | `main.ts`, `server.ts` | All remaining hardcoded paths |
| 16 | MEDIUM | `rollback.ts` | Git repo init check |
| 17 | MEDIUM | `state-machine.ts` | In-memory contract index cache |
| 18 | MEDIUM | `main.ts` | chokidar instead of fs.watch |
| 19 | HIGH | `ollama-adapter.ts` | File extraction in executeWorker |
| 20 | LOW | `server.ts` | CORS origin check |
| 21 | LOW | new `.env.example` | Document env vars |
| 22 | LOW | new `test.sample_module.json` | Missing test fixture |
| 23 | LOW | new `README.md` | Project documentation |