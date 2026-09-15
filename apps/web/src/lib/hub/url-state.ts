// Shareable Hub views: ?q=&cat=&sub=&sort=&status=&orch=1&api=1&int=native,planned. Defaults are omitted.

import { subcategoryLabel } from './filter';
import { DEFAULT_FILTERS, DEFAULT_QUERY, HUB_CATEGORIES, SORT_OPTIONS, type HubCategory, type HubQuery, type IntegrationType, type SortOption } from './types';

const INTEGRATIONS: readonly IntegrationType[] = ['native', 'openai-compatible', 'planned', 'no-public-api'];

interface ParamsLike {
  get(name: string): string | null;
}

export function parseHubQuery(params: ParamsLike): HubQuery {
  const cat = params.get('cat');
  const category: HubCategory | 'all' = cat && (HUB_CATEGORIES as readonly string[]).includes(cat) ? (cat as HubCategory) : 'all';
  const subParam = params.get('sub');
  const sub = category !== 'all' && subParam && subcategoryLabel(category, subParam) ? subParam : null;
  const sortParam = params.get('sort');
  const sort = sortParam && (SORT_OPTIONS as readonly string[]).includes(sortParam) ? (sortParam as SortOption) : DEFAULT_QUERY.sort;
  const status = params.get('status');
  const integrations = (params.get('int') ?? '')
    .split(',')
    .filter((value): value is IntegrationType => (INTEGRATIONS as readonly string[]).includes(value));
  return {
    q: (params.get('q') ?? '').slice(0, 120),
    category,
    sub,
    sort,
    filters: {
      connection: status === 'connected' || status === 'unconnected' ? status : 'all',
      orchestratorOnly: params.get('orch') === '1',
      apiOnly: params.get('api') === '1',
      integrations: [...new Set(integrations)],
    },
  };
}

/** Query string without the leading "?" (empty for the default view). Other, unrelated params are preserved. */
export function serializeHubQuery(query: HubQuery, base: URLSearchParams = new URLSearchParams()): string {
  const params = new URLSearchParams(base);
  const set = (key: string, value: string | null) => (value ? params.set(key, value) : params.delete(key));
  set('q', query.q.trim() ? query.q : null);
  set('cat', query.category !== 'all' ? query.category : null);
  set('sub', query.category !== 'all' && query.sub ? query.sub : null);
  set('sort', query.sort !== DEFAULT_QUERY.sort ? query.sort : null);
  set('status', query.filters.connection !== DEFAULT_FILTERS.connection ? query.filters.connection : null);
  set('orch', query.filters.orchestratorOnly ? '1' : null);
  set('api', query.filters.apiOnly ? '1' : null);
  set('int', query.filters.integrations.length > 0 ? query.filters.integrations.join(',') : null);
  return params.toString();
}
