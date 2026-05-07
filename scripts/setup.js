#!/usr/bin/env node
/**
 * SkyNetFactory Setup Script
 * Checks prerequisites, installs dependencies, and builds all components.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.env.SKYNET_FACTORY_ROOT || resolve('.');

function run(cmd, cwd = ROOT, opts = {}) {
  console.log(`[setup] ${cwd > ROOT ? cwd.replace(ROOT + '/', '') + '> ' : ''}${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true, ...opts });
}

function checkNode() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major < 18) {
    console.error(`[setup] ERROR: Node.js >= 18 required. Found ${version}`);
    process.exit(1);
  }
  console.log(`[setup] Node.js ${version} OK`);
}

async function checkOllama() {
  const url = process.env.OLLAMA_URL || 'http://localhost:11434';
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const models = data.models?.map(m => m.name) || [];
      console.log(`[setup] Ollama reachable at ${url}. Models: ${models.join(', ') || 'none'}`);
      return;
    }
  } catch {}
  console.warn(`[setup] WARNING: Ollama not reachable at ${url}`);
  console.warn(`[setup] Install from https://ollama.com and run: ollama serve`);
  console.warn(`[setup] Then pull the default model: ollama pull qwen3-coder`);
}

function ensureDirs() {
  const dirs = [
    'module-contracts/pending',
    'module-contracts/claimed',
    'module-contracts/building',
    'module-contracts/testing',
    'module-contracts/completed',
    'module-contracts/remediation',
    'module-contracts/rejected',
    'worktrees',
    'production-modules',
    'registry',
    'logs/evidence',
    'logs/failed_attempts',
    'temp/claims',
  ];
  for (const d of dirs) {
    const p = join(ROOT, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  console.log('[setup] Directory structure OK');
}

async function main() {
  console.log('[setup] SkyNetFactory setup starting...');
  console.log(`[setup] Root directory: ${ROOT}`);

  checkNode();
  await checkOllama();
  ensureDirs();

  // Install dependencies
  run('npm install', join(ROOT, 'supervisor'));
  run('npm install', join(ROOT, 'worker-runtime'));
  run('npm install', join(ROOT, 'ui/electron-app'));

  // Build
  run('npm run build', join(ROOT, 'supervisor'));
  run('npm run build', join(ROOT, 'worker-runtime'));

  // UI build is optional for dev (electron:dev uses vite directly)
  try {
    run('npm run build', join(ROOT, 'ui/electron-app'));
  } catch {
    console.warn('[setup] UI build skipped (dev mode will still work)');
  }

  console.log('[setup] ✅ Setup complete!');
  console.log('[setup] Next steps:');
  console.log('  1. Ensure Ollama is running: ollama serve');
  console.log('  2. Start supervisor: npm start');
  console.log('  3. Start UI (optional, new terminal): npm run start:ui');
  console.log('  4. Submit a contract: curl -X POST http://localhost:3013/skynetfactory/api/contracts -d @examples/sample-contract.json');
}

main().catch(err => {
  console.error('[setup] Fatal error:', err.message);
  process.exit(1);
});
