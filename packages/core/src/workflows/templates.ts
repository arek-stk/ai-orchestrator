import type { AgentRole } from '../domain/enums';
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowAgentNode,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowOutputFormat,
} from './types';
import { workflowTopologicalOrder } from './validation';

// Built-in templates ("Vorlage verwenden"). They reference Hub tools honestly: image, video and voice tools are part of
// the design and are flagged non-executable until an official API integration exists.

export const LAYOUT = Object.freeze({ nodeWidth: 240, nodeHeight: 150, columnGap: 36, rowGap: 72 });

/** Simple layered DAG layout: layer = longest path from a source; nodes centred per layer, definition order kept. */
export function layoutWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  const order = workflowTopologicalOrder(definition);
  if (!order) return definition;
  const layer = new Map<string, number>();
  for (const id of order) {
    const incoming = definition.edges.filter((e) => e.target === id).map((e) => (layer.get(e.source) ?? 0) + 1);
    layer.set(id, incoming.length > 0 ? Math.max(...incoming) : 0);
  }
  const layers = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const index = layer.get(node.id) ?? 0;
    layers.set(index, [...(layers.get(index) ?? []), node.id]);
  }
  const widest = Math.max(...[...layers.values()].map((ids) => ids.length));
  const totalWidth = widest * LAYOUT.nodeWidth + (widest - 1) * LAYOUT.columnGap;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [index, ids] of layers) {
    const rowWidth = ids.length * LAYOUT.nodeWidth + (ids.length - 1) * LAYOUT.columnGap;
    const offset = (totalWidth - rowWidth) / 2;
    ids.forEach((id, column) => positions.set(id, { x: Math.round(offset + column * (LAYOUT.nodeWidth + LAYOUT.columnGap)), y: index * (LAYOUT.nodeHeight + LAYOUT.rowGap) }));
  }
  return { ...definition, nodes: definition.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) };
}

const origin = { x: 0, y: 0 };

function agent(
  id: string,
  label: string,
  role: AgentRole,
  toolId: string,
  options: { instructions: string; description: string; tags: string[]; format?: WorkflowOutputFormat; artifactName?: string; temperature?: number; maxTokens?: number },
): WorkflowAgentNode {
  return {
    id,
    type: 'agent',
    label,
    position: origin,
    role,
    toolId,
    model: null,
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? 2000,
    enabledTools: [],
    output: { format: options.format ?? 'markdown', artifactName: options.artifactName ?? '' },
    instructions: options.instructions,
    description: options.description,
    tags: options.tags,
  };
}

const edges = (pairs: Array<[string, string]>): WorkflowEdge[] => pairs.map(([source, target]) => ({ id: `${source}--${target}`, source, target }));

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
}

function build(nodes: WorkflowNode[], pairs: Array<[string, string]>): WorkflowDefinition {
  return layoutWorkflow({ schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges: edges(pairs) });
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = Object.freeze([
  {
    id: 'marketing-kampagne',
    name: 'Marketing Kampagne',
    description: 'Automatisierter Workflow zur Erstellung einer kompletten Marketingkampagne',
    definition: build(
      [
        { id: 'ziel', type: 'goal', label: 'Ziel', position: origin, goal: 'Erstelle eine komplette Marketingkampagne für unser neues Produkt.' },
        { id: 'orchestrator', type: 'orchestrator', label: 'KI-Orchestrator', position: origin, description: 'Plant und koordiniert den gesamten Workflow.' },
        agent('research', 'Research Agent', 'researcher', 'perplexity', {
          description: 'Marktanalyse, Zielgruppenrecherche und Wettbewerbsanalyse.',
          tags: ['Recherche', 'Analyse'],
          instructions: 'Analysiere Markt, Zielgruppen und Wettbewerber für das Produkt. Nenne Quellen und kennzeichne Annahmen.',
          artifactName: 'marketing/recherche',
        }),
        agent('strategy', 'Strategy Agent', 'planner', 'claude', {
          description: 'Kampagnenstrategie und Positionierung.',
          tags: ['Strategie', 'Planung'],
          instructions: 'Entwickle Positionierung, Kernbotschaften, Kanäle und einen groben Zeitplan für die Kampagne.',
          artifactName: 'marketing/strategie',
          temperature: 0.5,
        }),
        agent('content', 'Content Agent', 'documentation', 'chatgpt', {
          description: 'Erstellt hochwertige Texte, Headlines und Social-Media-Inhalte für deine Kampagne.',
          tags: ['Text', 'Kreativität', 'Marketing', 'Kommunikation'],
          instructions: 'Schreibe 5 Headlines, einen Landingpage-Text und 5 Social-Media-Posts passend zur Positionierung.',
          artifactName: 'marketing/content',
        }),
        agent('design', 'Design Agent', 'frontend', 'midjourney', {
          description: 'Bilder und Visuals für die Kampagne.',
          tags: ['Bilder', 'Design'],
          instructions: 'Erstelle Key Visuals für Website und Social Media im Stil der Kampagne.',
          artifactName: 'marketing/visuals',
        }),
        agent('video', 'Video Agent', 'frontend', 'runway', {
          description: 'Kurzvideo für Social Media.',
          tags: ['Video', 'Animation'],
          instructions: 'Produziere ein 20-sekündiges Teaser-Video aus Strategie und Recherche.',
          artifactName: 'marketing/video',
        }),
        agent('voice', 'Voice Agent', 'documentation', 'elevenlabs', {
          description: 'Voice-over für das Video.',
          tags: ['Audio', 'Voice'],
          instructions: 'Erzeuge ein Voice-over auf Deutsch aus den Kampagnentexten.',
          artifactName: 'marketing/voice',
        }),
        { id: 'finale', type: 'finale', label: 'Finale', position: origin, description: 'Alle Inhalte werden zusammengeführt und für die Veröffentlichung vorbereitet.', output: { format: 'markdown', artifactName: 'marketing/kampagne' } },
      ],
      [
        ['ziel', 'orchestrator'],
        ['orchestrator', 'research'],
        ['orchestrator', 'strategy'],
        ['orchestrator', 'content'],
        ['orchestrator', 'design'],
        ['research', 'video'],
        ['strategy', 'video'],
        ['content', 'voice'],
        ['design', 'voice'],
        ['video', 'finale'],
        ['voice', 'finale'],
      ],
    ),
  },
  {
    id: 'blog-artikel',
    name: 'Blog-Artikel',
    description: 'Recherche, Entwurf und Lektorat eines Fachartikels – vollständig mit Text-Modellen',
    definition: build(
      [
        { id: 'ziel', type: 'goal', label: 'Ziel', position: origin, goal: 'Schreibe einen fundierten Blog-Artikel zu unserem Thema.' },
        agent('gliederung', 'Gliederung', 'planner', 'claude', {
          description: 'Leitfragen, Zielgruppe und Gliederung.',
          tags: ['Planung'],
          instructions: 'Erstelle Zielgruppe, Leitfragen und eine Gliederung mit 5–7 Abschnitten.',
          temperature: 0.4,
        }),
        agent('entwurf', 'Entwurf', 'documentation', 'chatgpt', {
          description: 'Ausformulierter Artikel.',
          tags: ['Text'],
          instructions: 'Schreibe den Artikel entlang der Gliederung, sachlich und gut lesbar.',
          maxTokens: 4000,
        }),
        agent('lektorat', 'Lektorat', 'reviewer', 'claude', {
          description: 'Prüft Fakten, Stil und Verständlichkeit.',
          tags: ['Review'],
          instructions: 'Überarbeite den Entwurf: Klarheit, Struktur, markiere unbelegte Aussagen.',
          temperature: 0.2,
          maxTokens: 4000,
        }),
        { id: 'finale', type: 'finale', label: 'Finale', position: origin, description: 'Finaler Artikel.', output: { format: 'markdown', artifactName: 'blog/artikel' } },
      ],
      [
        ['ziel', 'gliederung'],
        ['gliederung', 'entwurf'],
        ['entwurf', 'lektorat'],
        ['lektorat', 'finale'],
      ],
    ),
  },
  {
    id: 'wettbewerbsanalyse',
    name: 'Wettbewerbsanalyse',
    description: 'Zwei unabhängige Analysen parallel, danach eine Synthese',
    definition: build(
      [
        { id: 'ziel', type: 'goal', label: 'Ziel', position: origin, goal: 'Vergleiche unser Produkt mit den drei wichtigsten Wettbewerbern.' },
        { id: 'orchestrator', type: 'orchestrator', label: 'KI-Orchestrator', position: origin, description: 'Verteilt die Analyse auf zwei Perspektiven.' },
        agent('produkt', 'Produktvergleich', 'researcher', 'gemini', {
          description: 'Funktionen, Preise, Zielgruppen.',
          tags: ['Analyse'],
          instructions: 'Vergleiche Funktionen, Preismodelle und Zielgruppen. Kennzeichne Annahmen.',
        }),
        agent('positionierung', 'Positionierung', 'planner', 'claude', {
          description: 'Stärken, Schwächen, Chancen.',
          tags: ['Strategie'],
          instructions: 'Leite eine SWOT-Analyse und Differenzierungsmöglichkeiten ab.',
        }),
        { id: 'zusammenfuehrung', type: 'join', label: 'Zusammenführung', position: origin, description: 'Beide Analysen nebeneinander.' },
        agent('synthese', 'Synthese', 'reviewer', 'chatgpt', {
          description: 'Empfehlungen aus beiden Analysen.',
          tags: ['Empfehlung'],
          instructions: 'Fasse beide Analysen zu 5 priorisierten Empfehlungen zusammen.',
          temperature: 0.3,
        }),
        { id: 'finale', type: 'finale', label: 'Finale', position: origin, description: 'Bericht für das Team.', output: { format: 'markdown', artifactName: 'analyse/wettbewerb' } },
      ],
      [
        ['ziel', 'orchestrator'],
        ['orchestrator', 'produkt'],
        ['orchestrator', 'positionierung'],
        ['produkt', 'zusammenfuehrung'],
        ['positionierung', 'zusammenfuehrung'],
        ['zusammenfuehrung', 'synthese'],
        ['synthese', 'finale'],
      ],
    ),
  },
]);

export function findWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

/** An empty but valid starting point: goal → finale. */
export function blankWorkflowDefinition(): WorkflowDefinition {
  return build(
    [
      { id: 'ziel', type: 'goal', label: 'Ziel', position: origin, goal: '' },
      { id: 'finale', type: 'finale', label: 'Finale', position: origin, description: '', output: { format: 'markdown', artifactName: 'ergebnis' } },
    ],
    [['ziel', 'finale']],
  );
}
