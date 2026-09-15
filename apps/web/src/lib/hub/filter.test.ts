import { describe, expect, it } from 'vitest';
import { HUB_CATALOG } from './catalog';
import { activeFilterCount, applyHubQuery, categoryCounts, matchesSearch, normalize, subcategoryCounts, type ConnectionMap } from './filter';
import { DEFAULT_FILTERS, DEFAULT_QUERY, type AIConnection, type AITool, type HubQuery } from './types';

function tool(overrides: Partial<AITool> & Pick<AITool, 'id' | 'name'>): AITool {
  return {
    provider: 'Vendor',
    categories: ['chat'],
    subcategories: [],
    description: '',
    tagline: '',
    capabilities: [],
    tags: [],
    logo: { kind: 'monogram', value: 'X', accent: '#333333' },
    website: 'https://example.com',
    docsUrl: null,
    api: 'yes',
    pricing: 'Nutzungsbasiert',
    popularity: 50,
    addedAt: '2026-09-01',
    recommended: false,
    integration: 'planned',
    models: [],
    ...overrides,
  };
}

const tools: AITool[] = [
  tool({ id: 'alpha', name: 'Alpha Chat', provider: 'Acme', popularity: 90, integration: 'native', providerKind: 'openai', models: [{ id: 'a-1', label: 'Alpha Large' }] }),
  tool({
    id: 'voice',
    name: 'Voice Studio',
    categories: ['audio'],
    subcategories: ['audio:tts', 'audio:voice-cloning'],
    capabilities: [{ label: 'Text-to-Speech' }],
    popularity: 60,
    addedAt: '2026-09-10',
    recommended: true,
  }),
  tool({ id: 'scribe', name: 'Scribe', categories: ['audio'], subcategories: ['audio:stt'], popularity: 70, api: 'limited' }),
  tool({ id: 'clips', name: 'Clips', categories: ['video', 'audio'], subcategories: ['video:generierung', 'audio:tts'], popularity: 40, integration: 'no-public-api', api: 'no' }),
  tool({ id: 'bridge', name: 'Bridge', categories: ['chat', 'produktivitaet'], popularity: 20, integration: 'openai-compatible', addedAt: '2026-09-12' }),
];

const connected: AIConnection = { toolId: 'bridge', status: 'connected', connectedAt: null, selectedModel: null, orchestratorEnabled: true };
const connections: ConnectionMap = new Map([['bridge', connected]]);
const query = (patch: Partial<HubQuery> = {}): HubQuery => ({ ...DEFAULT_QUERY, ...patch, filters: { ...DEFAULT_FILTERS, ...patch.filters } });
const ids = (list: AITool[]) => list.map((t) => t.id);

describe('search', () => {
  it('matches name, provider, category, capability, sub-category and model, ignoring case and diacritics', () => {
    const alpha = tools[0]!;
    expect(matchesSearch(alpha, 'acme')).toBe(true);
    expect(matchesSearch(alpha, 'ALPHA large')).toBe(true);
    expect(matchesSearch(tools[1]!, 'text-to-speech')).toBe(true);
    expect(matchesSearch(tools[1]!, 'voice-cloning')).toBe(true);
    expect(matchesSearch(tools[4]!, 'produktivitat')).toBe(true);
    expect(matchesSearch(alpha, 'acme video')).toBe(false);
    expect(normalize('Übersetzung')).toBe('ubersetzung');
  });
});

describe('applyHubQuery', () => {
  it('sorts by popularity by default and supports every sort option', () => {
    expect(ids(applyHubQuery(tools, connections, query()))).toEqual(['alpha', 'scribe', 'voice', 'clips', 'bridge']);
    expect(ids(applyHubQuery(tools, connections, query({ sort: 'name' })))).toEqual(['alpha', 'bridge', 'clips', 'scribe', 'voice']);
    expect(ids(applyHubQuery(tools, connections, query({ sort: 'new' })))[0]).toBe('bridge');
    expect(ids(applyHubQuery(tools, connections, query({ sort: 'recommended' })))[0]).toBe('voice');
    expect(ids(applyHubQuery(tools, connections, query({ sort: 'connected' })))[0]).toBe('bridge');
  });

  it('combines category, sub-category, search, filters and sort', () => {
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio' })))).toEqual(['scribe', 'voice', 'clips']);
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio', sub: 'tts' })))).toEqual(['voice', 'clips']);
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio', sub: 'tts', sort: 'name' })))).toEqual(['clips', 'voice']);
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio', sub: 'tts', q: 'studio' })))).toEqual(['voice']);
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio', sub: 'tts', filters: { ...DEFAULT_FILTERS, apiOnly: true } })))).toEqual(['voice']);
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio', sub: 'musik' })))).toEqual([]);
  });

  it('ignores a sub-category that does not belong to the active category', () => {
    expect(ids(applyHubQuery(tools, connections, query({ category: 'audio', sub: 'generierung' })))).toEqual(['scribe', 'voice', 'clips']);
    expect(ids(applyHubQuery(tools, connections, query({ sub: 'tts' })))).toHaveLength(tools.length);
  });

  it('filters by connection, orchestrator support, API and integration type', () => {
    expect(ids(applyHubQuery(tools, connections, query({ filters: { ...DEFAULT_FILTERS, connection: 'connected' } })))).toEqual(['bridge']);
    expect(ids(applyHubQuery(tools, connections, query({ filters: { ...DEFAULT_FILTERS, connection: 'unconnected' } })))).not.toContain('bridge');
    expect(ids(applyHubQuery(tools, connections, query({ filters: { ...DEFAULT_FILTERS, orchestratorOnly: true } })))).toEqual(['alpha', 'bridge']);
    expect(ids(applyHubQuery(tools, connections, query({ filters: { ...DEFAULT_FILTERS, integrations: ['no-public-api', 'native'] } })))).toEqual(['alpha', 'clips']);
  });
});

describe('counts', () => {
  it('counts categories with search and filters but without the category itself', () => {
    const counts = categoryCounts(tools, connections, query({ category: 'audio', filters: { ...DEFAULT_FILTERS, apiOnly: true } }));
    expect(counts.all).toBe(3);
    expect(counts.audio).toBe(1);
    expect(counts.chat).toBe(2);
    expect(counts.video).toBe(0);
  });

  it('counts sub-categories inside the active category, combined with search and filters', () => {
    expect(subcategoryCounts(tools, connections, query())).toEqual({});
    expect(subcategoryCounts(tools, connections, query({ category: 'audio' }))).toEqual({ all: 3, tts: 2, stt: 1, musik: 0, 'voice-cloning': 1 });
    expect(subcategoryCounts(tools, connections, query({ category: 'audio', sub: 'stt', q: 'clips' }))).toEqual({ all: 1, tts: 1, stt: 0, musik: 0, 'voice-cloning': 0 });
  });

  it('counts active filter groups', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ connection: 'connected', orchestratorOnly: true, apiOnly: false, integrations: ['planned', 'native'] })).toBe(3);
  });
});

describe('catalog filtering', () => {
  it('finds speech tools through the audio sub-categories', () => {
    const tts = ids(applyHubQuery(HUB_CATALOG, new Map(), query({ category: 'audio', sub: 'tts' })));
    expect(tts).toContain('elevenlabs');
    expect(tts).toContain('openai-speech');
    const avatars = ids(applyHubQuery(HUB_CATALOG, new Map(), query({ category: 'video', sub: 'avatare' })));
    expect(avatars).toEqual(expect.arrayContaining(['synthesia', 'heygen']));
  });
});
