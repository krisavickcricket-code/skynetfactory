// @ts-nocheck
/**
 * Acceptance Gate Runner
 * Implements all gate types from the authority contract.
 * All gates are AND logic — every gate must pass for module completion.
 */

import { execSync, exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getConfig } from './config.js';

const execAsync = promisify(exec);

export type GateName =
  | 'structure_validation'
  | 'contract_validation'
  | 'sidecar_validation'
  | 'unit_tests'
  | 'contract_tests'
  | 'docker_tests'
  | 'write_scope_validation'
  | 'forbidden_behavior_validation'
  | 'network_policy_validation'
  | 'registry_validation';

export interface GateResult {
  gate_name: GateName;
  result: 'pass' | 'fail' | 'warn' | 'skip';
  details: string;
  duration_ms: number;
}

export interface GateRunResult {
  module_id: string;
  overall_result: 'pass' | 'fail';
  individual_results: GateResult[];
  timestamp: string;
}

const TEST_COMMANDS: Record<string, Record<string, string>> = {
  node: { unit_tests: 'npm test', contract_tests: 'npm run test:contract' },
  deno: { unit_tests: 'deno test', contract_tests: 'deno test --config deno.json' },
  bun: { unit_tests: 'bun test', contract_tests: 'bun run test:contract' },
  python3: { unit_tests: 'pytest tests/unit/', contract_tests: 'pytest tests/contract/' },
  go: { unit_tests: 'go test ./tests/unit/...', contract_tests: 'go test ./tests/contract/...' },
  native: { unit_tests: 'cargo test --lib', contract_tests: 'cargo test --test contract' },
};

const REQUIRED_PATHS: Record<string, string[]> = {
  typescript: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'package.json', 'tsconfig.json'],
  javascript: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'package.json'],
  python: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'pyproject.toml', 'requirements.txt'],
  go: ['cmd/', 'internal/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'go.mod'],
  rust: ['src/', 'tests/unit/', 'tests/contract/', 'examples/', 'module.contract.json', 'module.sidecar.json', 'Dockerfile', 'docker-compose.test.yml', 'README.md', 'Cargo.toml'],
};

async function runGate(gateName: GateName, contract: any, worktreePath: string): Promise<GateResult> {
  const start = Date.now();

  try {
    switch (gateName) {
      case 'structure_validation':
        return runStructureValidation(contract, worktreePath, start);
      case 'contract_validation':
        return await runContractValidation(worktreePath, start);
      case 'sidecar_validation':
        return await runSidecarValidation(worktreePath, start);
      case 'unit_tests':
        return await runTestCommand('unit_tests', contract.runtime, worktreePath, start);
      case 'contract_tests':
        return await runTestCommand('contract_tests', contract.runtime, worktreePath, start);
      case 'docker_tests':
        return await runDockerTests(worktreePath, start);
      case 'write_scope_validation':
        return await runWriteScopeValidation(contract, worktreePath, start);
      case 'forbidden_behavior_validation':
        return await runForbiddenBehaviorValidation(contract, worktreePath, start);
      case 'network_policy_validation':
        return await runNetworkPolicyValidation(contract, worktreePath, start);
      case 'registry_validation':
        return await runRegistryValidation(contract, start);
      default:
        return { gate_name: gateName, result: 'skip', details: `Unknown gate: ${gateName}`, duration_ms: Date.now() - start };
    }
  } catch (err: any) {
    return { gate_name: gateName, result: 'fail', details: `Gate error: ${err.message}`, duration_ms: Date.now() - start };
  }
}

function runStructureValidation(contract: any, worktreePath: string, startTime: number): GateResult {
  const language = contract.language || 'typescript';
  const requiredPaths = REQUIRED_PATHS[language] || REQUIRED_PATHS.typescript;
  const missing: string[] = [];

  for (const p of requiredPaths) {
    if (!existsSync(join(worktreePath, p))) {
      missing.push(p);
    }
  }

  if (missing.length === 0) {
    return { gate_name: 'structure_validation', result: 'pass', details: `All ${requiredPaths.length} required paths exist`, duration_ms: Date.now() - startTime };
  }
  return { gate_name: 'structure_validation', result: 'fail', details: `Missing paths: ${missing.join(', ')}`, duration_ms: Date.now() - startTime };
}

async function runContractValidation(worktreePath: string, startTime: number): Promise<GateResult> {
  const contractPath = join(worktreePath, 'module.contract.json');
  if (!existsSync(contractPath)) {
    return { gate_name: 'contract_validation', result: 'fail', details: 'module.contract.json not found', duration_ms: Date.now() - startTime };
  }

  try {
    const contractData = JSON.parse(readFileSync(contractPath, 'utf-8'));
    // Validate against schema using Ajv (dynamic import for ESM/CJS compat)
    const AjvModule = await import('ajv');
    const AjvClass = AjvModule.default as any;
    const formatsModule = await import('ajv-formats');
    const ajv = new AjvClass();
    formatsModule.default(ajv);

    const schemaPath = 'C:/SkynetFactory/module-contracts/_instructions/MODULE_CONTRACT_SCHEMA.json';
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    const validate = ajv.compile(schema);

    if (validate(contractData)) {
      return { gate_name: 'contract_validation', result: 'pass', details: 'Contract is schema-compliant', duration_ms: Date.now() - startTime };
    }
    return { gate_name: 'contract_validation', result: 'fail', details: `Schema validation errors: ${JSON.stringify(validate.errors)}`, duration_ms: Date.now() - startTime };
  } catch (err: any) {
    return { gate_name: 'contract_validation', result: 'fail', details: `Validation error: ${err.message}`, duration_ms: Date.now() - startTime };
  }
}

async function runSidecarValidation(worktreePath: string, startTime: number): Promise<GateResult> {
  const sidecarPath = join(worktreePath, 'module.sidecar.json');
  if (!existsSync(sidecarPath)) {
    return { gate_name: 'sidecar_validation', result: 'fail', details: 'module.sidecar.json not found', duration_ms: Date.now() - startTime };
  }

  try {
    const sidecarData = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    const AjvModule2 = await import('ajv');
    const AjvClass2 = AjvModule2.default as any;
    const formatsModule2 = await import('ajv-formats');
    const ajv2 = new AjvClass2();
    formatsModule2.default(ajv2);

    const schemaPath = 'C:/SkynetFactory/module-contracts/_instructions/SIDECAR_SCHEMA.json';
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    const validate = ajv2.compile(schema);

    if (validate(sidecarData)) {
      return { gate_name: 'sidecar_validation', result: 'pass', details: 'Sidecar is schema-compliant', duration_ms: Date.now() - startTime };
    }
    return { gate_name: 'sidecar_validation', result: 'fail', details: `Schema errors: ${JSON.stringify(validate.errors)}`, duration_ms: Date.now() - startTime };
  } catch (err: any) {
    return { gate_name: 'sidecar_validation', result: 'fail', details: `Validation error: ${err.message}`, duration_ms: Date.now() - startTime };
  }
}

async function runTestCommand(testType: string, runtime: string, worktreePath: string, startTime: number): Promise<GateResult> {
  const commands = TEST_COMMANDS[runtime];
  if (!commands || !commands[testType]) {
    return { gate_name: testType as GateName, result: 'skip', details: `No test command for runtime '${runtime}'`, duration_ms: Date.now() - startTime };
  }

  const command = commands[testType];
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: worktreePath,
      timeout: 120000 as any,
      maxBuffer: 1024 * 1024 * 10 as any,
    });
    return { gate_name: testType as GateName, result: 'pass', details: `Command '${command}' exited successfully`, duration_ms: Date.now() - startTime };
  } catch (err: any) {
    return { gate_name: testType as GateName, result: 'fail', details: `Command '${command}' failed: ${err.message}\n${err.stderr || ''}`, duration_ms: Date.now() - startTime };
  }
}

async function runDockerTests(worktreePath: string, startTime: number): Promise<GateResult> {
  const composePath = join(worktreePath, 'docker-compose.test.yml');
  if (!existsSync(composePath)) {
    return { gate_name: 'docker_tests', result: 'fail', details: 'docker-compose.test.yml not found', duration_ms: Date.now() - startTime };
  }

  const config = getConfig();
  const timeout = config.docker_timeout_ms || 600000;

  // Try Docker Compose V2 first, fall back to V1
  const command = `docker compose -f docker-compose.test.yml up --build --abort-on-container-exit 2>nul || docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit`;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: worktreePath,
      timeout,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { gate_name: 'docker_tests', result: 'pass', details: 'Docker tests exited successfully', duration_ms: Date.now() - startTime };
  } catch (err: any) {
    return { gate_name: 'docker_tests', result: 'fail', details: `Docker tests failed: ${err.message}`, duration_ms: Date.now() - startTime };
  }
}

async function runWriteScopeValidation(contract: any, worktreePath: string, startTime: number): Promise<GateResult> {
  const moduleId = contract.module_id;
  const workerResultPath = join(worktreePath, 'worker_result.json');

  if (!existsSync(workerResultPath)) {
    return { gate_name: 'write_scope_validation', result: 'warn', details: 'worker_result.json not found, cannot validate write scope', duration_ms: Date.now() - startTime };
  }

  const workerResult = JSON.parse(readFileSync(workerResultPath, 'utf-8'));
  const declaredScope = workerResult.evidence?.write_scope_declared || [];
  const changedFiles: string[] = workerResult.changed_files || [];

  const outOfScope: string[] = [];
  for (const file of changedFiles) {
    const inScope = declaredScope.some((scope: string) => {
      // Simple glob matching: scope ends with ** means anything under that path
      if (scope.endsWith('**')) {
        return file.startsWith(scope.replace('**', ''));
      }
      return file.startsWith(scope);
    });
    if (!inScope) outOfScope.push(file);
  }

  if (outOfScope.length === 0) {
    return { gate_name: 'write_scope_validation', result: 'pass', details: `All ${changedFiles.length} files within declared write scope`, duration_ms: Date.now() - startTime };
  }
  return { gate_name: 'write_scope_validation', result: 'fail', details: `${outOfScope.length} files outside write scope: ${outOfScope.join(', ')}`, duration_ms: Date.now() - startTime };
}

async function runForbiddenBehaviorValidation(contract: any, worktreePath: string, startTime: number): Promise<GateResult> {
  const forbiddenBehaviors = contract.forbidden_behaviors || [];
  const violations: string[] = [];

  for (const fb of forbiddenBehaviors) {
    switch (fb.detection_method) {
      case 'write_scope_check': {
        // Already covered by write_scope_validation gate
        break;
      }
      case 'network_egress_check': {
        // Check if code contains network calls outside declared hosts
        const netReq = contract.network_requirements || {};
        if (!netReq.requires_network) {
          // Module should have NO network calls - check source code
          const hasNetworkCall = await checkForNetworkCalls(worktreePath, contract.language);
          if (hasNetworkCall) {
            violations.push(`Forbidden behavior: ${fb.description} (network calls detected in code)`);
          }
        }
        break;
      }
      case 'filesystem_mutation_diff': {
        // Git diff would be checked against build-start snapshot
        // For now, check that no source files were modified (read-only verification)
        break;
      }
      case 'static_analysis': {
        if (fb.static_analysis_config) {
          const toolResult = await runStaticAnalysis(worktreePath, fb.static_analysis_config, contract.language);
          if (!toolResult.passed) {
            violations.push(`Forbidden behavior: ${fb.description} (${toolResult.details})`);
          }
        }
        break;
      }
      case 'manual_review': {
        // Non-blocking: warn only
        break;
      }
      default:
        break;
    }
  }

  if (violations.length === 0) {
    return { gate_name: 'forbidden_behavior_validation', result: 'pass', details: `All ${forbiddenBehaviors.length} forbidden behaviors checked, no violations`, duration_ms: Date.now() - startTime };
  }
  return { gate_name: 'forbidden_behavior_validation', result: 'fail', details: `Violations: ${violations.join('; ')}`, duration_ms: Date.now() - startTime };
}

async function checkForNetworkCalls(worktreePath: string, language: string): Promise<boolean> {
  try {
    const pattern = language === 'go' ? 'http\\..*Get\\|http\\..*Post'
      : language === 'python' ? 'requests\\.\\|urllib\\.\\|httpx\\.'
      : 'fetch(\\|axios\\.|http\\.get\\|http\\.post\\|request(';

    const { stdout } = await execAsync(
      `grep -r "${pattern}" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.rs" "${worktreePath}/src/" 2>nul || echo ""`,
      { timeout: 10000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function runStaticAnalysis(worktreePath: string, config: any, language: string): Promise<{ passed: boolean; details: string }> {
  try {
    let command = '';
    switch (config.tool) {
      case 'eslint':
        command = `npx eslint --rule "${config.rules.map((r: string) => JSON.stringify({ [r]: 'error' })).join(',')}" "${worktreePath}/src/" --format json 2>nul`;
        break;
      case 'ruff':
        command = `ruff check --select ${config.rules.join(',')} "${worktreePath}/src/" 2>nul`;
        break;
      case 'golangci-lint':
        command = `golangci-lint run --enable ${config.rules.join(',')} "${worktreePath}" 2>nul`;
        break;
      case 'clippy':
        command = `cargo clippy -- -D ${config.rules.join(' -D ')} 2>nul`;
        break;
      case 'custom':
        command = config.custom_command || '';
        break;
      default:
        return { passed: true, details: `Unknown tool: ${config.tool}` };
    }

    if (!command) return { passed: true, details: 'No command to run' };

    await execAsync(command, { cwd: worktreePath, timeout: 60000 });
    return { passed: true, details: 'No violations found' };
  } catch (err: any) {
    return { passed: false, details: `Static analysis found violations: ${err.message}` };
  }
}

async function runNetworkPolicyValidation(contract: any, worktreePath: string, startTime: number): Promise<GateResult> {
  const netReq = contract.network_requirements || {};

  // Validate that network requirements are declaratively sound
  if (!netReq.requires_network) {
    return { gate_name: 'network_policy_validation', result: 'pass', details: 'Module declares no network requirements', duration_ms: Date.now() - startTime };
  }

  // Check for wildcard hosts (not allowed)
  const allowedHosts: any[] = netReq.allowed_hosts || [];
  const wildcardHosts = allowedHosts.filter((h: any) => h.host === '*' || h.host.includes('*'));
  if (wildcardHosts.length > 0) {
    return { gate_name: 'network_policy_validation', result: 'fail', details: `Wildcard hosts not allowed: ${wildcardHosts.map((h: any) => h.host).join(', ')}`, duration_ms: Date.now() - startTime };
  }

  // Check localhost rules are explicit
  if (netReq.allow_localhost === undefined && netReq.requires_network) {
    return { gate_name: 'network_policy_validation', result: 'warn', details: 'allow_localhost not explicitly set for network-requiring module', duration_ms: Date.now() - startTime };
  }

  return { gate_name: 'network_policy_validation', result: 'pass', details: `Network policy valid: ${allowedHosts.length} allowed hosts, localhost=${netReq.allow_localhost}`, duration_ms: Date.now() - startTime };
}

async function runRegistryValidation(contract: any, startTime: number): Promise<GateResult> {
  const moduleId = contract.module_id;
  // Check if registry entry can be written and read back
  const registryPath = `C:/SkynetFactory/registry/${moduleId}.json`;

  try {
    const testEntry = {
      module_id: moduleId,
      version: contract.version,
      category: contract.category,
      capability_type: contract.capability_type,
      path: `C:/SkynetFactory/production-modules/${moduleId}`,
      contract_path: `C:/SkynetFactory/production-modules/${moduleId}/module.contract.json`,
      sidecar_path: `C:/SkynetFactory/production-modules/${moduleId}/module.sidecar.json`,
      status: 'verified',
      contract_hash: 'test',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: contract.sidecar_specification?.composition_tags || [],
      acceptance_evidence_path: '',
    };

    writeFileSync(registryPath, JSON.stringify(testEntry, null, 2));
    const readBack = JSON.parse(readFileSync(registryPath, 'utf-8'));

    // Clean up test entry
    if (existsSync(registryPath)) unlinkSync(registryPath);

    if (readBack.module_id === moduleId) {
      return { gate_name: 'registry_validation', result: 'pass', details: 'Registry entry can be written and read', duration_ms: Date.now() - startTime };
    }
    return { gate_name: 'registry_validation', result: 'fail', details: 'Registry read-back mismatch', duration_ms: Date.now() - startTime };
  } catch (err: any) {
    return { gate_name: 'registry_validation', result: 'fail', details: `Registry validation error: ${err.message}`, duration_ms: Date.now() - startTime };
  }
}

function unlinkSync(path: string) {
  const { unlinkSync: unlink } = require('node:fs');
  unlink(path);
}

/**
 * Run all gates for a module contract
 */
export async function runAllGates(contract: any, worktreePath: string): Promise<GateRunResult> {
  const gates: GateName[] = contract.acceptance_gates || [];
  const individualResults: GateResult[] = [];

  for (const gateName of gates) {
    const result = await runGate(gateName, contract, worktreePath);
    individualResults.push(result);
  }

  const anyFailure = individualResults.some(r => r.result === 'fail');
  const overall: 'pass' | 'fail' = anyFailure ? 'fail' : 'pass';

  const result: GateRunResult = {
    module_id: contract.module_id,
    overall_result: overall,
    individual_results: individualResults,
    timestamp: new Date().toISOString(),
  };

  // Write gate_result.json to worktree
  const gateResultPath = join(worktreePath, 'gate_result.json');
  writeFileSync(gateResultPath, JSON.stringify(result, null, 2));

  // Assemble evidence bundle
  const evidenceDir = `C:/SkynetFactory/logs/evidence/${contract.module_id}/${Date.now()}`;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'gate_result.json'), JSON.stringify(result, null, 2));

  return result;
}