/**
 * Rollback and Worktree Manager
 * Git worktree strategy per the authority contract's rollback_policy.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadState, saveState } from './state-machine.js';

const ROOT = 'C:/SkynetFactory';
const WORKTREES_DIR = join(ROOT, 'worktrees');
const PRODUCTION_DIR = join(ROOT, 'production-modules');
const FAILED_ATTEMPTS_DIR = join(ROOT, 'logs/failed_attempts');
const EVIDENCE_DIR = join(ROOT, 'logs/evidence');

function git(command: string, cwd?: string): string {
  const opts: any = { maxBuffer: 1024 * 1024 * 10 };
  if (cwd) opts.cwd = cwd;
  try {
    return execSync(`git ${command}`, opts).toString().trim();
  } catch (err: any) {
    throw new Error(`git ${command} failed: ${err.message}`);
  }
}

function gitOrEmpty(command: string, cwd?: string): string {
  try { return git(command, cwd); } catch { return ''; }
}

export function ensureWorktree(moduleId: string): string {
  const worktreePath = join(WORKTREES_DIR, moduleId);
  const branchName = `module/${moduleId}`;

  // Create branch if not exists
  const branchExists = gitOrEmpty(`branch --list ${branchName}`, ROOT).length > 0;
  if (!branchExists) {
    git(`checkout -b ${branchName}`, ROOT);
    git(`checkout main`, ROOT); // go back to main
  }

  // Create worktree if not exists
  if (!existsSync(worktreePath)) {
    mkdirSync(WORKTREES_DIR, { recursive: true });
    try {
      git(`worktree add "${worktreePath}" ${branchName}`, ROOT);
    } catch {
      // Worktree may already be registered but dir missing
      gitOrEmpty(`worktree remove "${worktreePath}" --force`, ROOT);
      git(`worktree add "${worktreePath}" ${branchName}`, ROOT);
    }
  }

  return worktreePath;
}

export function scaffoldModule(moduleId: string, contract: any, worktreePath: string): void {
  const language = contract.language || 'typescript';

  // Create directory structure based on language variant
  const dirs: Record<string, string[]> = {
    typescript: ['src', 'tests/unit', 'tests/contract', 'examples'],
    javascript: ['src', 'tests/unit', 'tests/contract', 'examples'],
    python: ['src', 'tests/unit', 'tests/contract', 'examples'],
    go: ['cmd', 'internal', 'tests/unit', 'tests/contract', 'examples'],
    rust: ['src', 'tests/unit', 'tests/contract', 'examples'],
  };

  const moduleDirs = dirs[language] || dirs.typescript;
  for (const dir of moduleDirs) {
    mkdirSync(join(worktreePath, dir), { recursive: true });
  }

  // Write contract and sidecar spec
  writeFileSync(join(worktreePath, 'module.contract.json'), JSON.stringify(contract, null, 2));

  const sidecar = {
    module_id: contract.module_id,
    version: contract.version,
    ...contract.sidecar_specification,
  };
  writeFileSync(join(worktreePath, 'module.sidecar.json'), JSON.stringify(sidecar, null, 2));

  // Create basic language files
  switch (language) {
    case 'typescript':
    case 'javascript':
      writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({
        name: moduleId,
        version: contract.version,
        scripts: { test: 'jest', 'test:contract': 'jest tests/contract/' },
        dependencies: {},
        devDependencies: { jest: '^29.0.0', typescript: '^5.0.0' },
      }, null, 2));
      break;
    case 'python':
      writeFileSync(join(worktreePath, 'pyproject.toml'), `[project]\nname = "${moduleId}"\nversion = "${contract.version}"\n`);
      writeFileSync(join(worktreePath, 'requirements.txt'), '');
      break;
    case 'go':
      writeFileSync(join(worktreePath, 'go.mod'), `module ${moduleId}\n\ngo 1.22\n`);
      break;
    case 'rust':
      writeFileSync(join(worktreePath, 'Cargo.toml'), `[package]\nname = "${moduleId}"\nversion = "${contract.version}"\nedition = "2021"\n`);
      break;
  }
}

export function commitAndTag(worktreePath: string, moduleId: string, attemptNumber: number, tagPrefix: string): string {
  const timestamp = Date.now();
  const message = `${tagPrefix}-${attemptNumber}-${timestamp}`;
  const tag = `${tagPrefix}-${attemptNumber}-${timestamp}`;

  gitOrEmpty('add -A', worktreePath);
  gitOrEmpty(`commit -m "${message}" --allow-empty`, worktreePath);
  gitOrEmpty(`tag ${tag}`, worktreePath);

  return tag;
}

export function rollbackWorktree(moduleId: string, buildStartTag: string): void {
  const worktreePath = join(WORKTREES_DIR, moduleId);
  if (!existsSync(worktreePath)) return;

  git(`reset --hard ${buildStartTag}`, worktreePath);
}

export function preserveFailedAttempt(moduleId: string, attemptNumber: number, buildStartTag: string): string {
  const worktreePath = join(WORKTREES_DIR, moduleId);
  const targetDir = join(FAILED_ATTEMPTS_DIR, moduleId, String(attemptNumber));
  mkdirSync(targetDir, { recursive: true });

  // Git diff from build-start tag
  try {
    const diff = gitOrEmpty(`diff ${buildStartTag}`, worktreePath);
    writeFileSync(join(targetDir, 'git_diff.patch'), diff);
  } catch {}

  // Copy worker_result.json
  const workerResultPath = join(worktreePath, 'worker_result.json');
  if (existsSync(workerResultPath)) {
    cpSync(workerResultPath, join(targetDir, 'worker_result.json'));
  }

  // Copy gate_result.json
  const gateResultPath = join(worktreePath, 'gate_result.json');
  if (existsSync(gateResultPath)) {
    cpSync(gateResultPath, join(targetDir, 'gate_result.json'));
  }

  return targetDir;
}

export function copyToProduction(moduleId: string): string {
  const worktreePath = join(WORKTREES_DIR, moduleId);
  const productionPath = join(PRODUCTION_DIR, moduleId);

  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree not found for ${moduleId}`);
  }

  mkdirSync(PRODUCTION_DIR, { recursive: true });

  // Remove old production copy if exists
  if (existsSync(productionPath)) {
    rmSync(productionPath, { recursive: true, force: true });
  }

  // Copy worktree to production (excluding .git)
  cpSync(worktreePath, productionPath, { recursive: true, filter: (src: string) => !src.includes('.git') });

  return productionPath;
}

export function archiveOldVersion(moduleId: string, oldVersion: string): string {
  const archiveDir = join(EVIDENCE_DIR, moduleId, 'archive', oldVersion);
  const productionPath = join(PRODUCTION_DIR, moduleId);

  mkdirSync(archiveDir, { recursive: true });

  if (existsSync(productionPath)) {
    cpSync(productionPath, archiveDir, { recursive: true });
  }

  return archiveDir;
}

export function tagVerified(moduleId: string, version: string): string {
  const worktreePath = join(WORKTREES_DIR, moduleId);
  const timestamp = Date.now();
  const tagName = `verified-${version}-${timestamp}`;

  gitOrEmpty(`tag ${tagName}`, worktreePath);
  gitOrEmpty(`add -A && git commit -m "verified-${version}-${timestamp}" --allow-empty`, worktreePath);

  return tagName;
}