// Pure search, category, filter and sort logic for the AI Hub. No React, no IO: unit tested in filter.test.ts.

import {
  CATEGORY_LABELS,
  HUB_CATEGORIES,
  SUBCATEGORIES,
  type AIConnection,
  type AITool,
  type HubCategory,
  type HubFilters,
  type HubQuery,
  type SortOption,
} from './types';

export type ConnectionMap = ReadonlyMap<string, AIConnection>;

/** Lowercase, without diacritics, so "produktivitat" finds "Produktivität". */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Integration types the orchestrator can route model calls to. */
export function supportsOrchestrator(tool: AITool): boolean {
  return tool.integration === 'native' || tool.integration === 'openai-compatible';
}

export function isConnected(connection: AIConnection | undefined): boolean {
  return connection?.status === 'connected';
}

/** "Vom Orchestrator verwendbar": supported integration, connected, and the service confirmed routable models. */
export function isOrchestratorUsable(tool: AITool, connection: AIConnection | undefined): boolean {
  return supportsOrchestrator(tool) && isConnected(connection) && connection?.orchestratorEnabled === true;
}

export function subcategoryLabel(category: HubCategory, sub: string): string | null {
  const map = (SUBCATEGORIES as Partial<Record<HubCategory, Record<string, string>>>)[category];
  return map?.[sub] ?? null;
}

export function subcategoriesOf(category: HubCategory | 'all'): Array<{ id: string; label: string }> {
  if (category === 'all') return [];
  const map = (SUBCATEGORIES as Partial<Record<HubCategory, Record<string, string>>>)[category];
  return map ? Object.entries(map).map(([id, label]) => ({ id, label })) : [];
}

function haystack(tool: AITool): string {
  return normalize(
    [
      tool.name,
      tool.provider,
      ...tool.categories.map((category) => CATEGORY_LABELS[category]),
      ...tool.subcategories.map((key) => {
        const [category, sub] = key.split(':') as [HubCategory, string];
        return subcategoryLabel(category, sub) ?? sub;
      }),
      ...tool.capabilities.flatMap((capability) => [capability.label, capability.detail ?? '']),
      ...tool.tags,
      ...tool.models.flatMap((model) => [model.id, model.label]),
    ].join('  '),
  );
}

const haystackCache = new WeakMap<AITool, string>();

/** Every whitespace-separated term must appear in name, provider, category, capability, tag or model. */
export function matchesSearch(tool: AITool, q: string): boolean {
  const terms = normalize(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  let text = haystackCache.get(tool);
  if (text === undefined) {
    text = haystack(tool);
    haystackCache.set(tool, text);
  }
  return terms.every((term) => text.includes(term));
}

export function matchesFilters(tool: AITool, connection: AIConnection | undefined, filters: HubFilters): boolean {
  if (filters.connection === 'connected' && !isConnected(connection)) return false;
  if (filters.connection === 'unconnected' && isConnected(connection)) return false;
  if (filters.orchestratorOnly && !supportsOrchestrator(tool)) return false;
  if (filters.apiOnly && tool.api !== 'yes') return false;
  if (filters.integrations.length > 0 && !filters.integrations.includes(tool.integration)) return false;
  return true;
}

export function matchesCategory(tool: AITool, category: HubCategory | 'all', sub: string | null): boolean {
  if (category === 'all') return true;
  if (!tool.categories.includes(category)) return false;
  if (sub && subcategoryLabel(category, sub)) return (tool.subcategories as string[]).includes(`${category}:${sub}`);
  return true;
}

export function sortTools(tools: readonly AITool[], sort: SortOption, connections: ConnectionMap): AITool[] {
  const byPopularity = (a: AITool, b: AITool) => b.popularity - a.popularity || a.name.localeCompare(b.name, 'de');
  const sorted = [...tools];
  switch (sort) {
    case 'name':
      return sorted.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    case 'new':
      return sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || byPopularity(a, b));
    case 'recommended':
      return sorted.sort((a, b) => Number(b.recommended) - Number(a.recommended) || byPopularity(a, b));
    case 'connected':
      return sorted.sort((a, b) => Number(isConnected(connections.get(b.id))) - Number(isConnected(connections.get(a.id))) || byPopularity(a, b));
    default:
      return sorted.sort(byPopularity);
  }
}

/** Search + category/sub-category + filters + sort. */
export function applyHubQuery(tools: readonly AITool[], connections: ConnectionMap, query: HubQuery): AITool[] {
  const visible = tools.filter(
    (tool) => matchesCategory(tool, query.category, query.sub) && matchesSearch(tool, query.q) && matchesFilters(tool, connections.get(tool.id), query.filters),
  );
  return sortTools(visible, query.sort, connections);
}

/** Pill counts: search and filters applied, category ignored (so every pill shows what selecting it would yield). */
export function categoryCounts(tools: readonly AITool[], connections: ConnectionMap, query: HubQuery): Record<HubCategory | 'all', number> {
  const base = tools.filter((tool) => matchesSearch(tool, query.q) && matchesFilters(tool, connections.get(tool.id), query.filters));
  const counts = Object.fromEntries([['all', base.length], ...HUB_CATEGORIES.map((category) => [category, 0])]) as Record<HubCategory | 'all', number>;
  for (const tool of base) for (const category of tool.categories) counts[category] += 1;
  return counts;
}

/** Sub-category chip counts within the active category, with search and filters applied. */
export function subcategoryCounts(tools: readonly AITool[], connections: ConnectionMap, query: HubQuery): Record<string, number> {
  if (query.category === 'all') return {};
  const category = query.category;
  const counts: Record<string, number> = { all: 0 };
  for (const { id } of subcategoriesOf(category)) counts[id] = 0;
  for (const tool of tools) {
    if (!matchesCategory(tool, category, null) || !matchesSearch(tool, query.q) || !matchesFilters(tool, connections.get(tool.id), query.filters)) continue;
    counts.all = (counts.all ?? 0) + 1;
    for (const key of tool.subcategories) {
      const [toolCategory, sub] = key.split(':');
      if (toolCategory === category && sub && sub in counts) counts[sub] = (counts[sub] ?? 0) + 1;
    }
  }
  return counts;
}

export function activeFilterCount(filters: HubFilters): number {
  return (filters.connection !== 'all' ? 1 : 0) + (filters.orchestratorOnly ? 1 : 0) + (filters.apiOnly ? 1 : 0) + (filters.integrations.length > 0 ? 1 : 0);
}
