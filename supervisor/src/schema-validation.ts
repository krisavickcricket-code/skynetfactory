import type { ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from './config.js';

const SCHEMA_DIR = join(ROOT_DIR, 'module-contracts/_instructions');

function readSchema(fileName: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, fileName), 'utf-8'));
}

async function createAjvWithContractSchemas(): Promise<any> {
  const AjvModule = await import('ajv/dist/2020.js');
  const AjvClass = AjvModule.default as any;
  const formatsModule = await import('ajv-formats');
  const ajv = new AjvClass();
  (formatsModule as any).default(ajv);
  ajv.addSchema(readSchema('API_SCHEMA.json'));
  ajv.addSchema(readSchema('DEPENDENCY_SCHEMA.json'));
  ajv.addSchema(readSchema('SIDECAR_SCHEMA.json'));
  return ajv;
}

export async function compileModuleContractValidator(): Promise<ValidateFunction> {
  const ajv = await createAjvWithContractSchemas();
  return ajv.compile(readSchema('MODULE_CONTRACT_SCHEMA.json'));
}

export async function compileSidecarValidator(): Promise<ValidateFunction> {
  const ajv = await createAjvWithContractSchemas();
  const validate = ajv.getSchema('skynetfactory://schemas/sidecar/v1.1');
  if (!validate) {
    throw new Error('SIDECAR_SCHEMA.json did not register a validator');
  }
  return validate;
}

export function formatSchemaErrors(errors: ValidateFunction['errors']): string[] {
  return (errors || []).map((error) => `${error.instancePath || '/'}: ${error.message}`);
}
