import { ApiHubService } from './api-service';
import { MockHubService } from './mock-service';
import type { HubMode, HubService } from './service';

export interface HubServiceOptions {
  mode: HubMode;
  /** Admin or owner: may store provider accounts in live mode. */
  canManage: boolean;
  /** Demo only: probability of simulated failures (e.g. `?hubFehler=1` for QA of error states). */
  failureRate?: number;
}

/**
 * Live mode reads and writes real orchestrator state; demo mode simulates connections. The page defaults to demo when
 * the server runs in demo mode (no real provider configured) and lets the user switch with `?quelle=live|demo`.
 */
export function createHubService(options: HubServiceOptions): HubService {
  if (options.mode === 'demo') return new MockHubService(options.failureRate !== undefined ? { failureRate: options.failureRate } : {});
  return new ApiHubService({ canManage: options.canManage });
}
