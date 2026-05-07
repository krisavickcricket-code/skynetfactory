/**
 * Registry Writer
 * File-per-module registry with atomic writes and index management.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT_DIR } from './config.js';

const REGISTRY_DIR = join(ROOT_DIR, 'registry');
const INDEX_PATH = join(REGISTRY_DIR, 'modules.json');

export interface RegistryEntry {
  module_id: string;
  version: string;
  category: string;
  capability_type: string;
  path: string;
  contract_path: string;
  sidecar_path: string;
  status: 'verified' | 'deprecated' | 'superseded';
  contract_hash: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  acceptance_evidence_path: string;
  agent_swarm_task_id?: string;
  remediation_history?: Array<{
    attempt: number;
    reason: string;
    remediated_at?: string;
    model_used?: string;
  }>;
}

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function register(entry: RegistryEntry): void {
  const entryPath = join(REGISTRY_DIR, `${entry.module_id}.json`);
  mkdirSync(REGISTRY_DIR, { recursive: true });
  atomicWrite(entryPath, JSON.stringify(entry, null, 2));
  rebuildIndex();
}

export function lookup(moduleId: string): RegistryEntry | null {
  const entryPath = join(REGISTRY_DIR, `${moduleId}.json`);
  if (!existsSync(entryPath)) return null;
  return JSON.parse(readFileSync(entryPath, 'utf-8'));
}

export function search(query: { category?: string; capability_type?: string; tags?: string[]; status?: string }): RegistryEntry[] {
  const index = loadIndex() as Array<Record<string, any>>;
  return index.filter(entry => {
    if (query.category && entry.category !== query.category) return false;
    if (query.capability_type && entry.capability_type !== query.capability_type) return false;
    if (query.status && entry.status !== query.status) return false;
    if (query.tags && query.tags.length > 0) {
      const entryTags: string[] = entry.tags || [];
      const hasAllTags = query.tags.every(t => entryTags.includes(t));
      if (!hasAllTags) return false;
    }
    return true;
  }) as RegistryEntry[];
}

export function deprecate(moduleId: string, reason: string): RegistryEntry | null {
  const entry = lookup(moduleId);
  if (!entry) return null;

  entry.status = 'deprecated';
  entry.updated_at = new Date().toISOString();
  const entryPath = join(REGISTRY_DIR, `${moduleId}.json`);
  atomicWrite(entryPath, JSON.stringify(entry, null, 2));
  rebuildIndex();
  return entry;
}

export function supersede(oldModuleId: string, newModuleId: string, newEntry: RegistryEntry): { old: RegistryEntry | null; new: RegistryEntry } {
  const oldEntry = lookup(oldModuleId);

  if (oldEntry) {
    oldEntry.status = 'superseded';
    oldEntry.updated_at = new Date().toISOString();
    const oldPath = join(REGISTRY_DIR, `${oldModuleId}.json`);
    atomicWrite(oldPath, JSON.stringify(oldEntry, null, 2));
  }

  register(newEntry);
  return { old: oldEntry, new: newEntry };
}

export function rebuildIndex(): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });

  const files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json') && f !== 'modules.json');
  const index: Array<Record<string, unknown>> = [];

  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(REGISTRY_DIR, file), 'utf-8'));
      index.push({
        module_id: entry.module_id,
        version: entry.version,
        category: entry.category,
        capability_type: entry.capability_type,
        status: entry.status,
        tags: entry.tags,
      });
    } catch {
      // Skip corrupted entries
    }
  }

  atomicWrite(INDEX_PATH, JSON.stringify(index, null, 2));
}

function loadIndex(): Array<Record<string, unknown>> {
  if (!existsSync(INDEX_PATH)) {
    rebuildIndex();
  }

  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export function getRegistryIndex(): Array<Record<string, unknown>> {
  return loadIndex();
}

export function computeContractHash(contractContent: string): string {
  return computeHash(contractContent);
}