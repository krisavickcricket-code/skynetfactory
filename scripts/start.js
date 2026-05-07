#!/usr/bin/env node
/**
 * SkyNetFactory Start Script
 * Starts the supervisor and optionally the UI.
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = process.env.SKYNET_FACTORY_ROOT || resolve('.');

function startSupervisor() {
  console.log('[start] Starting SkyNetFactory supervisor...');
  const proc = spawn('node', ['dist/api-server/main.js'], {
    cwd: join(ROOT, 'supervisor'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  proc.on('exit', (code) => {
    console.log(`[start] Supervisor exited with code ${code}`);
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => {
    console.log('[start] Received SIGINT, shutting down...');
    proc.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    console.log('[start] Received SIGTERM, shutting down...');
    proc.kill('SIGTERM');
  });
}

startSupervisor();
