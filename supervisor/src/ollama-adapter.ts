/**
 * Ollama Worker Adapter
 * Manages communication with Ollama API, enforce write scope, command allowlist,
 * model fallback chain, seed rotation, and temperature control.
 */

import { execSync, exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { getConfig, ROOT_DIR } from './config.js';
import { loadState, saveState } from './state-machine.js';

const execAsync = promisify(exec);

const ALLOWED_COMMANDS: Record<string, string[]> = {
  node: ['npm install', 'npm test', 'npm run build', 'npm run test:contract', 'node', 'npx', 'tsc', 'eslint'],
  python: ['pip install', 'pytest', 'python', 'python3', 'ruff', 'mypy', 'pip'],
  go: ['go build', 'go test', 'go mod tidy', 'go vet', 'golangci-lint'],
  rust: ['cargo build', 'cargo test', 'cargo clippy', 'cargo fmt'],
  common: ['docker compose', 'docker-compose', 'git diff', 'git status', 'git log'],
};

const DISALLOWED_PATTERNS = [
  'npm publish', 'git push', 'git push origin', 'curl', 'wget',
  'powershell -command', 'Invoke-WebRequest', 'Invoke-RestMethod',
  'Start-Process', 'bash -c \'curl', 'nc -', '/dev/tcp/',
];

export interface TaskPacket {
  task_id: string;
  module_id: string;
  module_contract: Record<string, unknown>;
  write_scope: string[];
  production_module_path: string;
  model: string;
  temperature: number;
  seed: number | null;
}

export interface OllamaResponse {
  model: string;
  message: { content: string };
  done: boolean;
}

/**
 * Derive write_scope for a module per the authority contract
 */
export function deriveWriteScope(moduleId: string): string[] {
  return [
    join(ROOT_DIR, 'worktrees', moduleId) + '/**',
    join(ROOT_DIR, 'logs', moduleId) + '/**',
  ];
}

/**
 * Check if a command is allowed by the per-runtime allowlist
 */
export function isCommandAllowed(command: string, runtime: string): boolean {
  // Check disallowed patterns first
  for (const pattern of DISALLOWED_PATTERNS) {
    if (command.toLowerCase().includes(pattern.toLowerCase())) {
      return false;
    }
  }

  // Check allowlist
  const allowed = [
    ...(ALLOWED_COMMANDS[runtime] || []),
    ...ALLOWED_COMMANDS.common,
  ];

  for (const prefix of allowed) {
    if (command.trim().toLowerCase().startsWith(prefix.toLowerCase())) {
      return true;
    }
  }

  // Allow commands that start with an exact match
  const firstWord = command.trim().split(/\s+/)[0];
  const directAllowed = ['node', 'npx', 'python', 'python3', 'pip', 'go', 'cargo', 'tsc', 'eslint', 'ruff', 'mypy', 'golangci-lint'];
  if (directAllowed.includes(firstWord)) return true;

  return false;
}

/**
 * Check if a file path is within the declared write scope
 */
export function isPathInWriteScope(filePath: string, writeScope: string[]): boolean {
  // Path traversal check
  if (filePath.includes('..')) return false;

  // Normalize both paths to forward slashes for consistent comparison
  const normalizedPath = filePath.replace(/\\/g, '/');
  return writeScope.some(scope => {
    const normalizedScope = scope.replace(/\\/g, '/');
    const scopePrefix = normalizedScope.replace(/\*\*$/, '');
    return normalizedPath.startsWith(scopePrefix);
  });
}

/**
 * Call Ollama API to generate code
 */
export async function callOllama(
  model: string,
  prompt: string,
  temperature: number = 0.1,
  seed: number | null = null,
): Promise<OllamaResponse> {
  const config = getConfig();
  const ollamaUrl = config.ollama_host_url || 'http://localhost:11434';

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    options: {
      temperature,
      ...(seed !== null ? { seed } : {}),
    },
  };

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data as OllamaResponse;
}

/**
 * Check model availability on Ollama
 */
export async function checkModelAvailability(model: string): Promise<boolean> {
  const config = getConfig();
  const ollamaUrl = config.ollama_host_url || 'http://localhost:11434';

  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    const data = await response.json();
    const models: string[] = (data as any).models?.map((m: any) => m.name) || [];
    return models.some(m => m.includes(model));
  } catch {
    return false;
  }
}

/**
 * Get the current model for a module, considering fallback chain
 */
export function getCurrentModel(moduleId: string): string {
  const state = loadState(moduleId);
  const config = getConfig();
  const consecutiveFailures = state?.consecutive_failure_count || 0;
  const fallbackThreshold = config.model_fallback_threshold || 3;

  const chain = [config.default_ollama_model || 'qwen3-coder', ...(config.fallback_models || ['deepseek-coder', 'glm', 'kimi'])];
  const fallbackIndex = Math.floor(consecutiveFailures / fallbackThreshold);

  return chain[Math.min(fallbackIndex, chain.length - 1)];
}

/**
 * Get seed with rotation for retry
 */
export function getSeed(attemptNumber: number): number {
  return attemptNumber * 7919 + 49157; // Simple deterministic seed rotation
}

/**
 * Build the task packet for a module contract
 */
export function buildTaskPacket(moduleId: string, contract: Record<string, unknown>): TaskPacket {
  const config = getConfig();
  const state = loadState(moduleId);
  const model = getCurrentModel(moduleId);
  const attemptCount = state?.attempt_count || 0;
  const seed = config.seed_control ? getSeed(attemptCount) : null;

  return {
    task_id: `task-${moduleId}-${Date.now()}`,
    module_id: moduleId,
    module_contract: contract,
    write_scope: deriveWriteScope(moduleId),
    production_module_path: join(ROOT_DIR, 'production-modules', moduleId),
    model,
    temperature: config.default_temperature || 0.1,
    seed,
  };
}

/**
 * Translate module contract to LLM prompt per contract_to_prompt_translation
 */
export function contractToPrompt(contract: Record<string, unknown>, taskPacket: TaskPacket): string {
  const language = (contract.language as string) || 'typescript';
  const runtime = (contract.runtime as string) || 'node';
  const worktreePath = join(ROOT_DIR, 'worktrees', String(contract.module_id));

  const sections = [
    `You are a module implementer for SkyNetFactory. You receive a module contract and produce a complete, tested, production-ready implementation. Follow the contract exactly. Do not add features beyond the contract. Do not skip any required test or file.`,
    `\n## Module Contract\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`,
    `\n## Implementation Requirements\n\n- API endpoints: ${(contract.api as any)?.endpoints?.map((e: any) => `${e.method} ${e.path}`).join(', ') || 'N/A'}
- Dependencies: ${JSON.stringify(contract.dependencies || [])}
- Network: ${(contract.network_requirements as any)?.requires_network ? 'Required' : 'Not required'}
- Forbidden: ${(contract.forbidden_behaviors as any)?.map((fb: any) => fb.description).join('; ') || 'None'}`,
    `\n## Output Structure (${language})\n\nRequired files: ${(getRequiredPaths(language) || []).join(', ')}`,
    `\n## Sidecar Specification\n\nFill out module.sidecar.json based on the following specification:\n\`\`\`json\n${JSON.stringify(contract.sidecar_specification, null, 2)}\n\`\`\``,
    `\n## Constraints\n\n1. Write scope: ${taskPacket.write_scope.join(', ')}\n2. Allowed commands: ${[...(ALLOWED_COMMANDS[runtime] || []), ...ALLOWED_COMMANDS.common].join(', ')}\n3. Network: ${(contract.network_requirements as any)?.requires_network ? 'External network access ALLOWED per allowed_hosts' : 'NO network access allowed'}\n4. Temperature: ${taskPacket.temperature}, Seed: ${taskPacket.seed}\n5. Working directory: ${worktreePath}`,
  ];

  return sections.join('\n');
}

function getRequiredPaths(language: string): string[] {
  const paths: Record<string, string[]> = {
    typescript: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'package.json', 'tsconfig.json'],
    javascript: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'package.json'],
    python: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'pyproject.toml', 'requirements.txt'],
    go: ['cmd/', 'internal/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'go.mod'],
    rust: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'Cargo.toml'],
  };
  return paths[language] || paths.typescript;
}

/**
 * Execute a worker run — call Ollama to implement a module
 */
/**
 * Extract files from LLM response using --- FILE: path --- ... --- END FILE --- format
 */
function extractFilesFromResponse(response: string, baseDir: string, writeScope: string[]): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
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

export async function executeWorker(taskPacket: TaskPacket, worktreePath: string): Promise<Record<string, unknown>> {
  const config = getConfig();
  const moduleId = taskPacket.module_id;
  const model = taskPacket.model;
  const prompt = contractToPrompt(taskPacket.module_contract, taskPacket);

  const promptHash = createHash('sha256').update(prompt).digest('hex');

  try {
    const response = await callOllama(model, prompt, taskPacket.temperature, taskPacket.seed);
    const content = response.message?.content || '';

    // Extract files from the LLM response (parses --- FILE: ... --- END FILE --- blocks)
    const extractedFiles = extractFilesFromResponse(content, worktreePath, taskPacket.write_scope);
    const filesWrittenLog: Array<{ path: string; size_bytes: number; sha256: string }> = [];
    for (const file of extractedFiles) {
      const dir = join(file.path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(file.path, file.content);
      filesWrittenLog.push({
        path: file.path,
        size_bytes: Buffer.byteLength(file.content),
        sha256: createHash('sha256').update(file.content).digest('hex'),
      });
    }
    // Also write full response for debugging
    writeFileSync(join(worktreePath, 'llm_response.md'), content);

    const changedFiles = extractedFiles.length > 0
      ? extractedFiles.map(f => f.path)
      : [join(worktreePath, 'llm_response.md')];

    return {
      task_id: taskPacket.task_id,
      module_id: moduleId,
      status: 'passed' as const,
      changed_files: changedFiles,
      evidence: {
        model_used: model,
        prompt_hash: promptHash,
        write_scope_declared: taskPacket.write_scope,
        commands_executed: [],
        files_written_log: filesWrittenLog,
        duration_ms: 0,
      },
    };
  } catch (err: any) {
    return {
      task_id: taskPacket.task_id,
      module_id: moduleId,
      status: 'failed' as const,
      changed_files: [],
      evidence: {
        model_used: model,
        prompt_hash: promptHash,
        write_scope_declared: taskPacket.write_scope,
        commands_executed: [],
        files_written_log: [],
        duration_ms: 0,
      },
      known_issues: [{ description: `Ollama call failed: ${err.message}`, severity: 'critical' }],
    };
  }
}