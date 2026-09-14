import { z } from 'zod';
import { ProviderError, type ProviderKind } from '@orch/core';

/**
 * Parses a provider's text response as JSON and validates it against the request schema.
 * Tolerates a surrounding ```json fence, which some OpenAI-compatible servers add.
 */
export function parseStructuredText<T>(text: string, schema: z.ZodType<T>, provider: ProviderKind, schemaName: string): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ProviderError('invalid_output', `${schemaName}: response is not valid JSON`, provider);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError('invalid_output', `${schemaName}: ${z.prettifyError(parsed.error)}`, provider);
  }
  return parsed.data;
}

/** JSON schema for providers that accept one directly (no `$schema` key). */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  format?: string;
  default?: unknown;
};

export interface SampleContext {
  /** Short text used to make placeholder strings meaningful (e.g. the task title). */
  hint: string;
}

const STRING_BY_KEY: ReadonlyArray<[RegExp, (hint: string) => string]> = [
  [/path|file/i, () => 'src/example.ts'],
  [/content|code|patch/i, (hint) => `// Generated in demo mode for: ${hint}\nexport {};\n`],
  [/command/i, () => 'npm test'],
  [/url/i, () => 'https://example.invalid'],
  [/id$/i, () => 'option-a'],
];

/**
 * Produces a deterministic value that satisfies a JSON schema (as emitted by zod's toJSONSchema).
 * Used by the mock provider when no role-specific responder is registered.
 */
export function sampleFromJsonSchema(schema: JsonSchema, context: SampleContext, key = ''): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants && variants.length > 0) {
    const nonNull = variants.find((v) => v.type !== 'null') ?? variants[0]!;
    return sampleFromJsonSchema(nonNull, context, key);
  }
  if (schema.allOf && schema.allOf.length > 0) {
    return sampleFromJsonSchema(Object.assign({}, ...schema.allOf) as JsonSchema, context, key);
  }

  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== 'null') ?? 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
        out[prop] = sampleFromJsonSchema(propSchema, context, prop);
      }
      return out;
    }
    case 'array': {
      const count = Math.max(1, schema.minItems ?? 0);
      return Array.from({ length: count }, () => sampleFromJsonSchema(schema.items ?? {}, context, key));
    }
    case 'string': {
      const producer = STRING_BY_KEY.find(([re]) => re.test(key))?.[1];
      let value = producer ? producer(context.hint) : `${key || 'value'}: ${context.hint}`;
      if (schema.minLength && value.length < schema.minLength) value = value.padEnd(schema.minLength, '.');
      if (schema.maxLength && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
      return value;
    }
    case 'integer':
    case 'number': {
      if (/confidence|score|probability/i.test(key)) {
        const max = schema.maximum ?? 1;
        return Math.min(max, 0.86 * max);
      }
      const min = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0);
      return type === 'integer' ? Math.ceil(min) : min;
    }
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}
