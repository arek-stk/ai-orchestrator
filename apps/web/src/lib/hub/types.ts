// AI Hub data model: a static tool catalog plus connection state that a HubService derives from the orchestrator
// (live) or simulates (demo). Pure types, shared by the service layer, the filter functions and the UI.

export const HUB_CATEGORIES = ['chat', 'recherche', 'bild', 'video', 'audio', 'coding', 'automation', 'produktivitaet'] as const;
export type HubCategory = (typeof HUB_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<HubCategory, string> = {
  chat: 'Chat',
  recherche: 'Recherche',
  bild: 'Bild',
  video: 'Video',
  audio: 'Audio',
  coding: 'Coding',
  automation: 'Automation',
  produktivitaet: 'Produktivität',
};

/** Secondary chips shown while a main category is active. Keys are `<category>:<sub>`. */
export const SUBCATEGORIES = {
  video: { generierung: 'Generierung', avatare: 'Avatare', editing: 'Editing' },
  audio: { tts: 'Sprachausgabe (TTS)', stt: 'Spracherkennung (STT)', musik: 'Musik', 'voice-cloning': 'Voice-Cloning' },
  bild: { generierung: 'Generierung', bearbeitung: 'Bearbeitung' },
  coding: { assistent: 'Assistent', agent: 'Agent' },
  recherche: { websuche: 'Websuche', rag: 'Wissensbasis/RAG' },
  automation: { workflows: 'Workflows', integrationen: 'Integrationen' },
} as const satisfies Partial<Record<HubCategory, Record<string, string>>>;

type SubcategoryMap = typeof SUBCATEGORIES;
export type SubcategoryKey = { [C in keyof SubcategoryMap]: `${C}:${Extract<keyof SubcategoryMap[C], string>}` }[keyof SubcategoryMap];

export type IntegrationType = 'native' | 'openai-compatible' | 'planned' | 'no-public-api';
export type ApiAvailability = 'yes' | 'no' | 'limited';
/** Orchestrator provider ids (packages/core PROVIDER_KINDS without mock). */
export type OrchestratorProviderKind = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

export type ToolLogo =
  /** Vendored, sanitised SVG under /public/logos, rendered on a fixed tile colour that keeps contrast in both themes. */
  | { kind: 'image'; src: string; bg: string; fallback: string; accent: string }
  /** Neutral tile: a monogram or a lucide icon name on a gradient derived from `accent`. */
  | { kind: 'monogram' | 'icon'; value: string; accent: string };

export interface ToolCapability {
  label: string;
  detail?: string;
}

export interface ToolModel {
  id: string;
  label: string;
  note?: string;
}

export interface AITool {
  id: string;
  name: string;
  provider: string;
  categories: HubCategory[];
  subcategories: SubcategoryKey[];
  /** One or two lines for the card. */
  description: string;
  /** One sentence for the detail panel. */
  tagline: string;
  capabilities: ToolCapability[];
  tags: string[];
  logo: ToolLogo;
  website: string;
  docsUrl: string | null;
  api: ApiAvailability;
  /** Short, non-numeric pricing model. */
  pricing: string;
  /** Editorial weighting for the "Beliebtheit" sort (0–100), not a measured metric. */
  popularity: number;
  /** When the entry was added to the catalog. */
  addedAt: string;
  recommended: boolean;
  integration: IntegrationType;
  providerKind?: OrchestratorProviderKind;
  /** Official OpenAI-compatible base URL, prefilled in the connect flow. */
  baseUrl?: string;
  /** Well-established model or product family names, shown as "Beispiele" when the registry has nothing better. */
  models: ToolModel[];
  /** Shown instead of examples when a tool routes to many third-party models. */
  modelsNote?: string;
}

export type ConnectionStatus = 'connected' | 'available' | 'error' | 'pending';

export interface AIConnection {
  toolId: string;
  status: ConnectionStatus;
  connectedAt: string | null;
  selectedModel: string | null;
  /** True only when the orchestrator can actually route model calls to this tool. */
  orchestratorEnabled: boolean;
  projectIds?: string[];
  /** Simulated connection (demo mode). */
  demo?: boolean;
  /** Where the credential lives in live mode; environment credentials cannot be removed from the UI. */
  source?: 'settings' | 'environment';
  providerId?: string;
  /** Human-readable reason for `error` or a non-usable connection. */
  detail?: string;
}

export interface ToolUsage {
  windowDays: number;
  tokens: number;
  calls: number;
  costUsd: number;
  /** Share of all orchestrator model spend (or tokens when spend is zero) in the window, 0–1. */
  share: number;
}

export interface ModelList {
  source: 'registry' | 'examples' | 'none';
  models: ToolModel[];
}

export const SORT_OPTIONS = ['popular', 'name', 'new', 'recommended', 'connected'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const SORT_LABELS: Record<SortOption, string> = {
  popular: 'Beliebtheit',
  name: 'Name',
  new: 'Neu hinzugefügt',
  recommended: 'Empfohlen',
  connected: 'Verbunden',
};

export interface HubFilters {
  /** `all` or only connected / only not connected tools. */
  connection: 'all' | 'connected' | 'unconnected';
  orchestratorOnly: boolean;
  apiOnly: boolean;
  integrations: IntegrationType[];
}

export interface HubQuery {
  q: string;
  category: HubCategory | 'all';
  sub: string | null;
  sort: SortOption;
  filters: HubFilters;
}

export const DEFAULT_FILTERS: HubFilters = { connection: 'all', orchestratorOnly: false, apiOnly: false, integrations: [] };
export const DEFAULT_QUERY: HubQuery = { q: '', category: 'all', sub: null, sort: 'popular', filters: DEFAULT_FILTERS };

export const INTEGRATION_LABELS: Record<IntegrationType, string> = {
  native: 'Nativ',
  'openai-compatible': 'OpenAI-kompatibel',
  planned: 'Geplant',
  'no-public-api': 'Keine öffentliche API',
};
