import type { ModelConfig, ProviderKind } from '../models/types';
import type { ToolName } from '../tools/tool-router';
import type { WorkflowAgentNode, WorkflowBlocker, WorkflowDefinition, WorkflowRunMode } from './types';

// Honest executability (docs/plans/workflows.md §5). The tool list mirrors the AI Hub catalog
// (apps/web/src/lib/hub/catalog.ts; a test keeps both in sync): an agent node can run only when its tool is integrated
// natively or through a documented OpenAI-compatible endpoint, a provider account for it is usable and the model
// registry has an enabled model that routes through that account (same rule as the Hub's "Nutzbar").

export type WorkflowToolIntegration = 'native' | 'openai-compatible' | 'planned' | 'no-public-api';

export interface WorkflowToolInfo {
  id: string;
  name: string;
  vendor: string;
  integration: WorkflowToolIntegration;
  providerKind: Exclude<ProviderKind, 'mock'> | null;
  /** Official OpenAI-compatible base URL (host matching against provider accounts). */
  baseUrl: string | null;
}

const tool = (id: string, name: string, vendor: string, integration: WorkflowToolIntegration, providerKind: WorkflowToolInfo['providerKind'] = null, baseUrl: string | null = null): WorkflowToolInfo => ({
  id,
  name,
  vendor,
  integration,
  providerKind,
  baseUrl,
});

export const WORKFLOW_TOOLS: readonly WorkflowToolInfo[] = Object.freeze([
  tool('chatgpt', 'ChatGPT & OpenAI API', 'OpenAI', 'native', 'openai'),
  tool('claude', 'Claude', 'Anthropic', 'native', 'anthropic'),
  tool('gemini', 'Gemini', 'Google', 'native', 'google'),
  tool('mistral', 'Mistral AI', 'Mistral AI', 'openai-compatible', 'openai-compatible', 'https://api.mistral.ai/v1'),
  tool('deepseek', 'DeepSeek', 'DeepSeek', 'openai-compatible', 'openai-compatible', 'https://api.deepseek.com'),
  tool('groq', 'Groq', 'Groq', 'openai-compatible', 'openai-compatible', 'https://api.groq.com/openai/v1'),
  tool('openrouter', 'OpenRouter', 'OpenRouter', 'openai-compatible', 'openai-compatible', 'https://openrouter.ai/api/v1'),
  tool('ollama', 'Ollama', 'Ollama', 'openai-compatible', 'openai-compatible', 'http://localhost:11434/v1'),
  tool('cohere', 'Cohere', 'Cohere', 'openai-compatible', 'openai-compatible', 'https://api.cohere.ai/compatibility/v1'),
  tool('hugging-face', 'Hugging Face', 'Hugging Face', 'openai-compatible', 'openai-compatible', 'https://router.huggingface.co/v1'),
  tool('perplexity', 'Perplexity', 'Perplexity AI', 'planned'),
  tool('pinecone', 'Pinecone', 'Pinecone', 'planned'),
  tool('midjourney', 'Midjourney', 'Midjourney', 'no-public-api'),
  tool('openai-images', 'OpenAI Bildgenerierung', 'OpenAI', 'planned'),
  tool('stability-ai', 'Stability AI', 'Stability AI', 'planned'),
  tool('black-forest-labs', 'FLUX', 'Black Forest Labs', 'planned'),
  tool('ideogram', 'Ideogram', 'Ideogram', 'planned'),
  tool('adobe-firefly', 'Adobe Firefly', 'Adobe', 'planned'),
  tool('runway', 'Runway', 'Runway', 'planned'),
  tool('luma-ai', 'Luma AI', 'Luma AI', 'planned'),
  tool('pika', 'Pika', 'Pika', 'planned'),
  tool('synthesia', 'Synthesia', 'Synthesia', 'planned'),
  tool('heygen', 'HeyGen', 'HeyGen', 'planned'),
  tool('google-veo', 'Veo', 'Google', 'planned'),
  tool('kling-ai', 'Kling AI', 'Kuaishou', 'planned'),
  tool('descript', 'Descript', 'Descript', 'planned'),
  tool('elevenlabs', 'ElevenLabs', 'ElevenLabs', 'planned'),
  tool('openai-speech', 'OpenAI Speech', 'OpenAI', 'planned'),
  tool('deepgram', 'Deepgram', 'Deepgram', 'planned'),
  tool('assemblyai', 'AssemblyAI', 'AssemblyAI', 'planned'),
  tool('speechmatics', 'Speechmatics', 'Speechmatics', 'planned'),
  tool('resemble-ai', 'Resemble AI', 'Resemble AI', 'planned'),
  tool('suno', 'Suno', 'Suno', 'no-public-api'),
  tool('github-copilot', 'GitHub Copilot', 'GitHub', 'no-public-api'),
  tool('deepl', 'DeepL', 'DeepL', 'planned'),
  tool('notion-ai', 'Notion AI', 'Notion', 'no-public-api'),
  tool('zapier', 'Zapier', 'Zapier', 'planned'),
]);

const TOOLS_BY_ID = new Map(WORKFLOW_TOOLS.map((t) => [t.id, t]));

export function findWorkflowTool(id: string): WorkflowToolInfo | undefined {
  return TOOLS_BY_ID.get(id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool toggles ("Tools & Integrationen")
// ---------------------------------------------------------------------------------------------------------------------

export interface WorkflowToolToggle {
  id: 'web_search' | 'file_analysis' | 'image_generation';
  label: string;
  /** Tool router tool that would back the toggle; null when the router has no such tool at all. */
  toolName: ToolName | null;
}

export const WORKFLOW_TOOL_TOGGLES: readonly WorkflowToolToggle[] = Object.freeze([
  { id: 'web_search', label: 'Websuche', toolName: 'research.web' },
  { id: 'file_analysis', label: 'Dateien analysieren', toolName: 'repository.read' },
  { id: 'image_generation', label: 'Bilder generieren', toolName: null },
]);

/**
 * Router tools the workflow runner can hand to an agent node. Empty in stage 1: workflow agents have no tool loop, so
 * enabling a toggle would promise a capability that does not exist.
 */
export const WORKFLOW_RUNNER_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>();

export interface ToggleAvailability extends WorkflowToolToggle {
  available: boolean;
  reason: string | null;
}

export function workflowToggleAvailability(registeredTools: readonly ToolName[]): ToggleAvailability[] {
  const registered = new Set(registeredTools);
  return WORKFLOW_TOOL_TOGGLES.map((toggle) => {
    if (!toggle.toolName) return { ...toggle, available: false, reason: 'Der Tool-Router hat kein Werkzeug für diese Fähigkeit.' };
    if (!registered.has(toggle.toolName)) return { ...toggle, available: false, reason: `„${toggle.toolName}“ ist im Tool-Router noch nicht registriert.` };
    if (!WORKFLOW_RUNNER_TOOLS.has(toggle.toolName)) return { ...toggle, available: false, reason: 'Für Workflow-Agenten noch nicht angebunden.' };
    return { ...toggle, available: true, reason: null };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Executability
// ---------------------------------------------------------------------------------------------------------------------

/** A provider account as the server knows it (never with the key). */
export interface WorkflowProviderAccount {
  id: string;
  kind: ProviderKind;
  baseUrl: string | null;
  enabled: boolean;
  usable: boolean;
  source: 'environment' | 'settings';
}

export interface ExecutabilityEnvironment {
  mode: WorkflowRunMode;
  models: readonly ModelConfig[];
  accounts: readonly WorkflowProviderAccount[];
  /** Whether the provider resolver has a live adapter for the model. */
  isModelAvailable: (model: ModelConfig) => boolean;
}

export type ExecutabilityCode = 'ok' | 'unknown_tool' | 'integration_planned' | 'no_public_api' | 'not_connected' | 'no_model' | 'model_unavailable';

export interface NodeExecutability {
  nodeId: string;
  executable: boolean;
  code: ExecutabilityCode;
  message: string;
  /** Registry models the node may route to (live mode); empty in demo mode or when not executable. */
  modelIds: string[];
  demo: boolean;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return null;
  }
}

/** Registry models that route through the tool's account, mirroring DefaultProviderResolver and the Hub. */
export function workflowToolModels(info: WorkflowToolInfo, env: Pick<ExecutabilityEnvironment, 'models' | 'accounts' | 'isModelAvailable'>): ModelConfig[] {
  const routable = (model: ModelConfig) => model.enabled && env.isModelAvailable(model);
  if (info.integration === 'native' && info.providerKind) {
    return env.models.filter((model) => model.provider === info.providerKind && routable(model));
  }
  if (info.integration !== 'openai-compatible') return [];
  const host = hostOf(info.baseUrl);
  const account = env.accounts.find((a) => a.kind === 'openai-compatible' && a.usable && (a.id === `hub-${info.id}` || (host !== null && hostOf(a.baseUrl) === host)));
  if (!account) return [];
  // The resolver uses the first enabled environment account, then stored ones, for models without an explicit account.
  const ordered = [...env.accounts.filter((a) => a.source === 'environment'), ...env.accounts.filter((a) => a.source === 'settings')];
  const defaultCompatible = ordered.find((a) => a.kind === 'openai-compatible' && a.enabled)?.id;
  return env.models.filter(
    (model) => model.provider === 'openai-compatible' && (model.providerConfigId === account.id || (model.providerConfigId === null && defaultCompatible === account.id)) && routable(model),
  );
}

export const EXECUTABILITY_MESSAGES: Record<ExecutabilityCode, string> = {
  ok: 'Ausführbar',
  unknown_tool: 'Nicht ausführbar – unbekanntes Tool',
  integration_planned: 'Nicht ausführbar – Integration fehlt',
  no_public_api: 'Nicht ausführbar – keine offizielle API',
  not_connected: 'Nicht ausführbar – Tool ist nicht verbunden',
  no_model: 'Nicht ausführbar – kein verfügbares Modell in der Registry',
  model_unavailable: 'Nicht ausführbar – gewähltes Modell ist nicht verfügbar',
};

function result(nodeId: string, code: ExecutabilityCode, demo: boolean, modelIds: string[] = [], detail?: string): NodeExecutability {
  return { nodeId, executable: code === 'ok', code, message: detail ? `${EXECUTABILITY_MESSAGES[code]} (${detail})` : EXECUTABILITY_MESSAGES[code], modelIds, demo };
}

export function assessAgentNode(node: WorkflowAgentNode, env: ExecutabilityEnvironment): NodeExecutability {
  const demo = env.mode === 'demo';
  const info = findWorkflowTool(node.toolId);
  if (!info) return result(node.id, 'unknown_tool', demo);
  if (info.integration === 'planned') return result(node.id, 'integration_planned', demo);
  if (info.integration === 'no-public-api') return result(node.id, 'no_public_api', demo);
  // Demo mode simulates supported integrations only; unsupported ones stay non-executable.
  if (demo) return result(node.id, 'ok', true);

  const models = workflowToolModels(info, env);
  if (models.length === 0) {
    const connected =
      info.integration === 'native'
        ? env.accounts.some((a) => a.kind === info.providerKind && a.usable)
        : env.accounts.some((a) => a.kind === 'openai-compatible' && a.usable && (a.id === `hub-${info.id}` || (hostOf(info.baseUrl) !== null && hostOf(a.baseUrl) === hostOf(info.baseUrl))));
    return result(node.id, connected ? 'no_model' : 'not_connected', false);
  }
  if (node.model && !models.some((m) => m.id === node.model)) return result(node.id, 'model_unavailable', false, [], node.model);
  const ordered = node.model ? [node.model, ...models.filter((m) => m.id !== node.model).map((m) => m.id)] : models.map((m) => m.id);
  return result(node.id, 'ok', false, ordered);
}

/** Executability of every agent node; other node types are deterministic and always runnable. */
export function assessWorkflow(definition: WorkflowDefinition, env: ExecutabilityEnvironment): Map<string, NodeExecutability> {
  const map = new Map<string, NodeExecutability>();
  for (const node of definition.nodes) {
    if (node.type === 'agent') map.set(node.id, assessAgentNode(node, env));
  }
  return map;
}

export function workflowBlockers(definition: WorkflowDefinition, assessment: ReadonlyMap<string, NodeExecutability>): WorkflowBlocker[] {
  return definition.nodes.flatMap((node) => {
    const entry = assessment.get(node.id);
    return entry && !entry.executable ? [{ nodeId: node.id, label: node.label, code: entry.code, message: entry.message }] : [];
  });
}
