// How a tool's connection and orchestrator state is described in the UI. Kept pure so the honesty rules are tested:
// "Vom Orchestrator verwendbar" only for connected native/OpenAI-compatible tools with routable models.

import { isOrchestratorUsable, supportsOrchestrator } from './filter';
import type { AIConnection, AITool } from './types';

export type HubTone = 'good' | 'warning' | 'critical' | 'muted' | 'accent';

export interface StateLabel {
  tone: HubTone;
  label: string;
}

export function connectionBadge(tool: AITool, connection: AIConnection | undefined): StateLabel {
  switch (connection?.status) {
    case 'connected':
      return { tone: 'good', label: connection.demo ? 'Verbunden · Demo' : 'Verbunden' };
    case 'error':
      return { tone: 'critical', label: 'Verbindung fehlerhaft' };
    case 'pending':
      return { tone: 'warning', label: 'Ausstehend' };
    default:
      break;
  }
  if (supportsOrchestrator(tool)) return { tone: 'muted', label: 'Verfügbar' };
  if (tool.integration === 'no-public-api') return { tone: 'muted', label: 'Kein API-Zugang' };
  return { tone: 'muted', label: tool.api === 'yes' ? 'API verfügbar' : tool.api === 'limited' ? 'API eingeschränkt' : 'Keine API' };
}

export function orchestratorState(tool: AITool, connection: AIConnection | undefined): StateLabel {
  if (tool.integration === 'no-public-api') return { tone: 'muted', label: tool.api === 'limited' ? 'Keine offene API für den Orchestrator' : 'Kein offizieller API-Zugang' };
  if (tool.integration === 'planned') return { tone: 'muted', label: 'Integration geplant' };
  if (isOrchestratorUsable(tool, connection)) return { tone: 'good', label: 'Vom Orchestrator verwendbar' };
  if (connection?.status === 'connected') return { tone: 'warning', label: 'Verbunden, noch kein nutzbares Modell' };
  if (connection?.status === 'error') return { tone: 'critical', label: 'Zugang prüfen' };
  return { tone: 'muted', label: 'Nach Verbindung nutzbar' };
}

export type PrimaryAction = 'manage' | 'connect' | 'details' | 'learn';

export function primaryAction(tool: AITool, connection: AIConnection | undefined): PrimaryAction {
  if (connection && connection.status !== 'available') return 'manage';
  if (supportsOrchestrator(tool)) return 'connect';
  return tool.integration === 'no-public-api' ? 'learn' : 'details';
}

export const PRIMARY_ACTION_LABELS: Record<PrimaryAction, string> = {
  manage: 'Verbindung verwalten',
  connect: 'Jetzt verbinden',
  details: 'Details ansehen',
  learn: 'Mehr erfahren',
};

export const API_LABELS: Record<AITool['api'], string> = { yes: 'Ja', limited: 'Eingeschränkt', no: 'Nein' };
