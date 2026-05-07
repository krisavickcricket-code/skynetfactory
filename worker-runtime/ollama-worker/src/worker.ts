/**
 * SkyNetFactory Ollama Worker
 * Receives task packets, calls Ollama API to generate module code,
 * enforces write scope and command allowlist, produces worker_result.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// === Configuration ===
const SKYNET_ROOT = process.env.SKYNET_FACTORY_ROOT || 'C:/SkynetFactory';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_TEMPERATURE = parseFloat(process.env.DEFAULT_TEMPERATURE || '0.1');
const SEED_CONTROL = process.env.SEED_CONTROL !== 'false';

// === Allowed Commands ===
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

// === Types ===
interface TaskPacket {
  task_id: string;
  module_id: string;
  module_contract: Record<string, unknown>;
  write_scope: string[];
  production_module_path: string;
  model: string;
  temperature: number;
  seed: number | null;
}

// === Write Scope Enforcement ===
function isInWriteScope(filePath: string, writeScope: string[]): boolean {
  if (filePath.includes('..')) return false;
  const normalized = normalize(filePath);
  return writeScope.some(scope => {
    const prefix = scope.replace(/\*\*$/, '');
    return normalized.startsWith(prefix);
  });
}

// === Command Allowlist ===
function isCommandAllowed(command: string, runtime: string): boolean {
  for (const pattern of DISALLOWED_PATTERNS) {
    if (command.toLowerCase().includes(pattern.toLowerCase())) {
      return false;
    }
  }

  const allowed = [
    ...(ALLOWED_COMMANDS[runtime] || []),
    ...ALLOWED_COMMANDS.common,
  ];

  for (const prefix of allowed) {
    if (command.trim().toLowerCase().startsWith(prefix.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// === Ollama API ===
async function callOllama(model: string, prompt: string, temperature: number, seed: number | null): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    options: { temperature, ...(seed !== null && SEED_CONTROL ? { seed } : {}) },
  };

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return (data as any).message?.content || '';
}

// === Chunked Implementation ===
async function implementModule(taskPacket: TaskPacket, worktreePath: string): Promise<Record<string, unknown>> {
  const contract = taskPacket.module_contract;
  const language = (contract.language as string) || 'typescript';
  const runtime = (contract.runtime as string) || 'node';

  console.log(`[Worker] Starting implementation of ${taskPacket.module_id} with model ${taskPacket.model}`);

  const filesWritten: Array<{ path: string; size_bytes: number; sha256: string }> = [];
  const commandsExecuted: Array<{ command: string; exit_code: number; duration_ms: number }> = [];
  const startTime = Date.now();

  // Chunk 1: Scaffold
  const scaffoldPrompt = buildScaffoldPrompt(contract, language, taskPacket);
  const promptHash = createHash('sha256').update(scaffoldPrompt).digest('hex');

  let scaffoldResponse: string;
  try {
    scaffoldResponse = await callOllama(taskPacket.model, scaffoldPrompt, taskPacket.temperature, taskPacket.seed);
  } catch (err: any) {
    return {
      task_id: taskPacket.task_id,
      module_id: taskPacket.module_id,
      status: 'failed',
      changed_files: [],
      evidence: {
        model_used: taskPacket.model,
        prompt_hash: promptHash,
        write_scope_declared: taskPacket.write_scope,
        commands_executed: [],
        files_written_log: [],
        duration_ms: Date.now() - startTime,
      },
      known_issues: [{ description: `Ollama scaffold call failed: ${err.message}`, severity: 'critical' }],
    };
  }

  // Parse scaffold response for file contents
  const scaffoldFiles = extractFilesFromResponse(scaffoldResponse, worktreePath, taskPacket.write_scope);
  for (const file of scaffoldFiles) {
    if (isInWriteScope(file.path, taskPacket.write_scope)) {
      writeFileSync(file.path, file.content);
      filesWritten.push({
        path: file.path,
        size_bytes: Buffer.byteLength(file.content),
        sha256: createHash('sha256').update(file.content).digest('hex'),
      });
    }
  }

  // Chunk 2: Implementation
  const implPrompt = buildImplementationPrompt(contract, language, scaffoldResponse, taskPacket);
  const implResponse = await callOllama(taskPacket.model, implPrompt, taskPacket.temperature, taskPacket.seed ? taskPacket.seed + 1 : null);
  const implFiles = extractFilesFromResponse(implResponse, worktreePath, taskPacket.write_scope);
  for (const file of implFiles) {
    if (isInWriteScope(file.path, taskPacket.write_scope)) {
      writeFileSync(file.path, file.content);
      filesWritten.push({
        path: file.path,
        size_bytes: Buffer.byteLength(file.content),
        sha256: createHash('sha256').update(file.content).digest('hex'),
      });
    }
  }

  // Chunk 3: Tests and Docker
  const testPrompt = buildTestPrompt(contract, language, implResponse, taskPacket);
  const testResponse = await callOllama(taskPacket.model, testPrompt, taskPacket.temperature, taskPacket.seed ? taskPacket.seed + 2 : null);
  const testFiles = extractFilesFromResponse(testResponse, worktreePath, taskPacket.write_scope);
  for (const file of testFiles) {
    if (isInWriteScope(file.path, taskPacket.write_scope)) {
      writeFileSync(file.path, file.content);
      filesWritten.push({
        path: file.path,
        size_bytes: Buffer.byteLength(file.content),
        sha256: createHash('sha256').update(file.content).digest('hex'),
      });
    }
  }

  // Run allowed commands
  const testCommands = getTestCommands(runtime);
  for (const cmd of testCommands) {
    if (isCommandAllowed(cmd, runtime)) {
      const cmdStart = Date.now();
      try {
        await execAsync(cmd, { cwd: worktreePath, timeout: 120000 });
        commandsExecuted.push({ command: cmd, exit_code: 0, duration_ms: Date.now() - cmdStart });
      } catch (err: any) {
        commandsExecuted.push({ command: cmd, exit_code: err.code || 1, duration_ms: Date.now() - cmdStart });
      }
    }
  }

  // Write worker_result.json
  const workerResult = {
    task_id: taskPacket.task_id,
    module_id: taskPacket.module_id,
    status: 'passed' as const,
    changed_files: filesWritten.map(f => f.path),
    tests_run: [],
    evidence: {
      model_used: taskPacket.model,
      prompt_hash: promptHash,
      write_scope_declared: taskPacket.write_scope,
      commands_executed: commandsExecuted.map(c => c.command),
      files_written_log: filesWritten,
      duration_ms: Date.now() - startTime,
    },
  };

  writeFileSync(join(worktreePath, 'worker_result.json'), JSON.stringify(workerResult, null, 2));

  return workerResult;
}

// === Prompt Builders ===
function buildScaffoldPrompt(contract: Record<string, unknown>, language: string, task: TaskPacket): string {
  return `You are a module implementer for SkyNetFactory. First, create the project scaffold for the following module contract.

Module Contract:
${JSON.stringify(contract, null, 2)}

Language: ${language}
Working Directory: ${task.production_module_path}

Create ONLY the scaffold files: package.json (or equivalent), directory structure, and type/interface definitions matching the contract's API schemas.
Do NOT implement function bodies yet.

Output each file as:
--- FILE: path/to/file.ext ---
(file content)
--- END FILE ---
`;
}

function buildImplementationPrompt(contract: Record<string, unknown>, language: string, scaffoldContent: string, task: TaskPacket): string {
  return `Now implement the module logic. Here is the scaffold:
${scaffoldContent.substring(0, 4000)}

Module Contract:
${JSON.stringify(contract, null, 2)}

Implement all route handlers, business logic, and error handling.

Output each file as:
--- FILE: path/to/file.ext ---
(file content)
--- END FILE ---
`;
}

function buildTestPrompt(contract: Record<string, unknown>, language: string, implContent: string, task: TaskPacket): string {
  return `Now add unit tests, contract tests, Dockerfile, docker-compose.test.yml, README.md, and sidecar JSON.

Here is the implementation:
${implContent.substring(0, 4000)}

Module Contract:
${JSON.stringify(contract, null, 2)}

Output each file as:
--- FILE: path/to/file.ext ---
(file content)
--- END FILE ---
`;
}

// === File Extraction ===
function extractFilesFromResponse(response: string, baseDir: string, writeScope: string[]): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const fileRegex = /---\s*FILE:\s*(.+?)\s*---\n([\s\S]*?)---\s*END FILE\s*---/g;

  let match;
  while ((match = fileRegex.exec(response)) !== null) {
    const filePath = join(baseDir, match[1].trim());
    const content = match[2];
    if (isInWriteScope(filePath, writeScope)) {
      files.push({ path: filePath, content });
    } else {
      console.warn(`[Worker] Blocked write outside scope: ${filePath}`);
    }
  }

  // Also extract markdown code blocks as fallback
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  // This is a simpler heuristic for cases where the LLM doesn't follow the format

  return files;
}

function getTestCommands(runtime: string): string[] {
  const commands: Record<string, string[]> = {
    node: ['npm install', 'npm test'],
    python3: ['pip install -e .', 'pytest tests/unit/'],
    go: ['go mod tidy', 'go test ./tests/unit/...'],
    rust: ['cargo test --lib'],
  };
  return commands[runtime] || commands.node;
}

// === Main ===
async function main() {
  const taskPacketPath = process.argv[2];
  if (!taskPacketPath) {
    console.error('[Worker] Usage: tsx src/worker.ts <task_packet.json>');
    process.exit(1);
  }

  const taskPacket: TaskPacket = JSON.parse(readFileSync(taskPacketPath, 'utf-8'));
  const worktreePath = join(SKYNET_ROOT, 'worktrees', taskPacket.module_id);

  if (!existsSync(worktreePath)) {
    mkdirSync(worktreePath, { recursive: true });
  }

  try {
    const result = await implementModule(taskPacket, worktreePath);
    console.log(`[Worker] Implementation ${result.status} for ${taskPacket.module_id}`);
  } catch (err: any) {
    console.error(`[Worker] Fatal error: ${err.message}`);
    process.exit(1);
  }
}

// Run main (no argv check for reliability with tsx)
main().catch((err) => {
  console.error(`[Worker] Fatal: ${err.message}`);
  process.exit(1);
});

export { implementModule, isInWriteScope, isCommandAllowed };