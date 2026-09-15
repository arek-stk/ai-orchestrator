'use client';

import { useId } from 'react';
import { formatCountDe } from '@/lib/hub/format';
import { Skeleton } from '../ui';

const NODES = [
  { x: 62, y: 64, r: 2.6 },
  { x: 48, y: 176, r: 2.2 },
  { x: 140, y: 222, r: 2.8 },
  { x: 128, y: 112, r: 3.2 },
  { x: 222, y: 28, r: 2.4 },
  { x: 356, y: 44, r: 3 },
  { x: 432, y: 118, r: 2.4 },
  { x: 404, y: 210, r: 3.2 },
  { x: 296, y: 236, r: 2.4 },
  { x: 186, y: 174, r: 2.2 },
  { x: 330, y: 150, r: 2 },
] as const;

const CENTER = { x: 250, y: 128 };
const HUB_EDGES = [3, 4, 5, 6, 7, 8, 9, 10];
const MESH_EDGES: Array<[number, number]> = [
  [0, 3],
  [1, 3],
  [1, 2],
  [2, 9],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 10],
  [3, 9],
];

/** Abstract orchestrator network: a core with connected nodes and orbits. Inline SVG, gradients only, no filters. */
export function NetworkVisual({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg aria-hidden="true" viewBox="0 0 480 260" preserveAspectRatio="xMidYMid meet" className={className}>
      <defs>
        <linearGradient id={`${id}-edge`} x1="40" y1="0" x2="440" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--hub-blue)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--hub-violet)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hub-cyan)' }} />
        </linearGradient>
        <radialGradient id={`${id}-halo`}>
          <stop offset="0" style={{ stopColor: 'var(--hub-violet)', stopOpacity: 0.55 }} />
          <stop offset="0.45" style={{ stopColor: 'var(--hub-blue)', stopOpacity: 0.18 }} />
          <stop offset="1" style={{ stopColor: 'var(--hub-blue)', stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}-core`} cx="0.38" cy="0.34" r="0.75">
          <stop offset="0" style={{ stopColor: 'var(--hub-cyan)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--hub-blue)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hub-violet)' }} />
        </radialGradient>
        <radialGradient id={`${id}-node`}>
          <stop offset="0" style={{ stopColor: 'var(--hub-cyan)', stopOpacity: 0.5 }} />
          <stop offset="1" style={{ stopColor: 'var(--hub-cyan)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>

      <g fill="none" stroke={`url(#${id}-edge)`} strokeWidth="1" opacity="0.28">
        <ellipse cx={CENTER.x} cy={CENTER.y} rx="200" ry="72" transform={`rotate(-10 ${CENTER.x} ${CENTER.y})`} />
        <ellipse cx={CENTER.x} cy={CENTER.y} rx="140" ry="108" transform={`rotate(24 ${CENTER.x} ${CENTER.y})`} strokeDasharray="2 6" />
        <ellipse cx={CENTER.x} cy={CENTER.y} rx="92" ry="46" transform={`rotate(-28 ${CENTER.x} ${CENTER.y})`} />
      </g>

      <circle className="hub-breathe" cx={CENTER.x} cy={CENTER.y} r="108" fill={`url(#${id}-halo)`} />

      <g stroke={`url(#${id}-edge)`} strokeLinecap="round">
        {MESH_EDGES.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={NODES[a]!.x} y1={NODES[a]!.y} x2={NODES[b]!.x} y2={NODES[b]!.y} strokeWidth="0.8" opacity="0.35" />
        ))}
        {HUB_EDGES.map((index) => (
          <line key={index} x1={CENTER.x} y1={CENTER.y} x2={NODES[index]!.x} y2={NODES[index]!.y} strokeWidth="1.1" opacity="0.6" />
        ))}
      </g>

      {NODES.map((node, index) => (
        <g key={index}>
          <circle cx={node.x} cy={node.y} r={node.r * 4} fill={`url(#${id}-node)`} />
          <circle cx={node.x} cy={node.y} r={node.r} style={{ fill: index % 3 === 0 ? 'var(--hub-violet)' : 'var(--hub-cyan)' }} />
        </g>
      ))}

      <circle cx={CENTER.x} cy={CENTER.y} r="40" fill="none" stroke={`url(#${id}-edge)`} strokeWidth="1" opacity="0.5" />
      <circle cx={CENTER.x} cy={CENTER.y} r="24" fill={`url(#${id}-core)`} />
      <ellipse cx={CENTER.x - 7} cy={CENTER.y - 9} rx="9" ry="5" fill="white" opacity="0.28" />
    </svg>
  );
}

export function HubHero({ total, connected, usable, loading }: { total: number; connected: number; usable: number; loading: boolean }) {
  const headingId = useId();
  const stats = [
    { label: 'KI-Tools im Katalog', value: total },
    { label: 'Verbunden', value: connected },
    { label: 'Im Orchestrator nutzbar', value: usable },
  ];
  return (
    <section aria-labelledby={headingId} className="hub-hero @container relative overflow-hidden rounded-3xl border border-hub-line">
      <div className="relative grid items-center gap-2 px-5 py-6 @lg:px-8 @lg:py-8 @3xl:grid-cols-[minmax(0,1fr)_300px] @5xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">
          <h2 id={headingId} className="text-[26px] font-semibold leading-[1.12] tracking-[-0.025em] text-ink @lg:text-[30px] @5xl:text-[34px]">
            Eine Plattform.
            <br />
            <span className="hub-heading-gradient @lg:whitespace-nowrap">Unendliche KI-Möglichkeiten.</span>
          </h2>
          <p className="mt-3 max-w-[48ch] text-[14px] leading-relaxed text-ink-2 sm:text-[15px]">
            Verbinde deine bevorzugten KI-Modelle und Tools mit deinem Orchestrator und lass sie gemeinsam für dich arbeiten.
          </p>
          <dl className="mt-6 flex flex-wrap gap-x-7 gap-y-3">
            {stats.map((stat) => (
              <div key={stat.label} className="min-w-0">
                <dt className="text-xs text-ink-2">{stat.label}</dt>
                <dd className="tabular mt-0.5 text-[22px] font-semibold leading-7 tracking-[-0.01em] text-ink">
                  {loading ? <Skeleton className="mt-1 h-6 w-10" /> : formatCountDe(stat.value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <NetworkVisual className="pointer-events-none -mx-4 hidden h-[200px] w-auto @lg:block @3xl:mx-0 @3xl:h-[220px] @5xl:h-[240px]" />
      </div>
    </section>
  );
}
