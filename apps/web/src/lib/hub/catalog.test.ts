import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_CATALOG } from './catalog';
import { connectionBadge, orchestratorState, primaryAction } from './presentation';
import { parseHubQuery, serializeHubQuery } from './url-state';
import { CATEGORY_LABELS, DEFAULT_QUERY, SUBCATEGORIES, type AIConnection } from './types';

const publicDir = join(__dirname, '..', '..', '..', 'public');

describe('catalog invariants', () => {
  it('has unique ids and the required tools', () => {
    const ids = HUB_CATALOG.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['chatgpt', 'claude', 'gemini', 'perplexity', 'mistral', 'deepseek', 'groq', 'openrouter', 'ollama', 'midjourney', 'openai-images', 'stability-ai', 'runway', 'elevenlabs', 'github-copilot', 'deepl', 'notion-ai', 'zapier', 'pinecone']) {
      expect(ids).toContain(id);
    }
  });

  it('labels integrations honestly', () => {
    for (const tool of HUB_CATALOG) {
      if (tool.integration === 'native') expect(['openai', 'anthropic', 'google']).toContain(tool.providerKind);
      if (tool.integration === 'openai-compatible') {
        expect(tool.providerKind).toBe('openai-compatible');
        expect(tool.baseUrl).toMatch(/^(https:\/\/|http:\/\/localhost:)/);
      }
      if (tool.integration === 'planned' || tool.integration === 'no-public-api') expect(tool.providerKind).toBeUndefined();
      if (tool.integration === 'no-public-api') expect(tool.api).not.toBe('yes');
    }
    expect(HUB_CATALOG.filter((tool) => tool.integration === 'native').map((tool) => tool.id).sort()).toEqual(['chatgpt', 'claude', 'gemini']);
    expect(HUB_CATALOG.find((tool) => tool.id === 'midjourney')?.integration).toBe('no-public-api');
  });

  it('uses https links, known categories, consistent sub-categories and short non-numeric pricing', () => {
    for (const tool of HUB_CATALOG) {
      expect(tool.website).toMatch(/^https:\/\//);
      if (tool.docsUrl) expect(tool.docsUrl).toMatch(/^https:\/\//);
      for (const category of tool.categories) expect(CATEGORY_LABELS[category]).toBeDefined();
      for (const key of tool.subcategories) {
        const [category, sub] = key.split(':') as [keyof typeof SUBCATEGORIES, string];
        expect(tool.categories).toContain(category);
        expect((SUBCATEGORIES[category] as Record<string, string>)[sub]).toBeDefined();
      }
      expect(tool.pricing).not.toMatch(/\d/);
      expect(tool.capabilities.length).toBeGreaterThanOrEqual(2);
      expect(tool.tags.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('ships a sanitised SVG for every image logo', () => {
    for (const tool of HUB_CATALOG) {
      if (tool.logo.kind !== 'image') continue;
      const file = join(publicDir, tool.logo.src);
      expect(existsSync(file), tool.logo.src).toBe(true);
      const svg = readFileSync(file, 'utf8');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toMatch(/<script|on[a-z]+=|href=|data:|<style|foreignObject/i);
    }
    expect(existsSync(join(publicDir, 'logos', 'SOURCES.md'))).toBe(true);
  });
});

describe('presentation honesty rules', () => {
  const claude = HUB_CATALOG.find((tool) => tool.id === 'claude')!;
  const runway = HUB_CATALOG.find((tool) => tool.id === 'runway')!;
  const midjourney = HUB_CATALOG.find((tool) => tool.id === 'midjourney')!;
  const base: AIConnection = { toolId: 'claude', status: 'connected', connectedAt: null, selectedModel: null, orchestratorEnabled: true };

  it('says "Vom Orchestrator verwendbar" only for connected, routable native or compatible tools', () => {
    expect(orchestratorState(claude, base).label).toBe('Vom Orchestrator verwendbar');
    expect(orchestratorState(claude, { ...base, orchestratorEnabled: false }).label).not.toBe('Vom Orchestrator verwendbar');
    expect(orchestratorState(claude, undefined).label).toBe('Nach Verbindung nutzbar');
    expect(orchestratorState(runway, { ...base, toolId: 'runway' }).label).toBe('Integration geplant');
    expect(orchestratorState(midjourney, undefined).label).toBe('Kein offizieller API-Zugang');
  });

  it('offers connect only where the orchestrator can use the tool', () => {
    expect(primaryAction(claude, undefined)).toBe('connect');
    expect(primaryAction(claude, base)).toBe('manage');
    expect(primaryAction(runway, undefined)).toBe('details');
    expect(primaryAction(midjourney, undefined)).toBe('learn');
    expect(connectionBadge(claude, { ...base, demo: true }).label).toBe('Verbunden · Demo');
    expect(connectionBadge(midjourney, undefined).label).toBe('Kein API-Zugang');
  });
});

describe('url state', () => {
  it('round-trips a full query and omits defaults', () => {
    const q = {
      q: 'stimme',
      category: 'audio' as const,
      sub: 'tts',
      sort: 'name' as const,
      filters: { connection: 'unconnected' as const, orchestratorOnly: true, apiOnly: true, integrations: ['planned' as const] },
    };
    const text = serializeHubQuery(q);
    expect(text).toBe('q=stimme&cat=audio&sub=tts&sort=name&status=unconnected&orch=1&api=1&int=planned');
    expect(parseHubQuery(new URLSearchParams(text))).toEqual(q);
    expect(serializeHubQuery(DEFAULT_QUERY)).toBe('');
  });

  it('drops invalid values and a sub-category without its category', () => {
    const parsed = parseHubQuery(new URLSearchParams('cat=nope&sub=tts&sort=weird&status=x&int=native,bogus,native'));
    expect(parsed).toEqual({ ...DEFAULT_QUERY, filters: { ...DEFAULT_QUERY.filters, integrations: ['native'] } });
    expect(parseHubQuery(new URLSearchParams('cat=video&sub=tts')).sub).toBeNull();
  });

  it('keeps unrelated parameters', () => {
    expect(serializeHubQuery({ ...DEFAULT_QUERY, category: 'video' }, new URLSearchParams('source=demo&cat=bild'))).toBe('source=demo&cat=video');
  });
});
