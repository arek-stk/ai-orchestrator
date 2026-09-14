import { describe, expect, it } from 'vitest';
import { CycleError, dependencyState, findCycle, parallelLayers, topologicalOrder } from './dag';
import type { TaskStatus } from '../domain/enums';

const nodes = [
  { id: 'api', dependencies: [] },
  { id: 'ui', dependencies: ['api'] },
  { id: 'docs', dependencies: [] },
  { id: 'e2e', dependencies: ['ui', 'api'] },
];

describe('dag', () => {
  it('orders dependencies before their dependents', () => {
    const order = topologicalOrder(nodes);
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('ui'));
    expect(order.indexOf('ui')).toBeLessThan(order.indexOf('e2e'));
    expect(order).toHaveLength(4);
  });

  it('groups independent work into parallel layers', () => {
    expect(parallelLayers(nodes)).toEqual([['api', 'docs'], ['ui'], ['e2e']]);
  });

  it('detects cycles and reports the cycle path', () => {
    const cyclic = [
      { id: 'a', dependencies: ['c'] },
      { id: 'b', dependencies: ['a'] },
      { id: 'c', dependencies: ['b'] },
      { id: 'd', dependencies: [] },
    ];
    const cycle = findCycle(cyclic);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
    expect(() => topologicalOrder(cyclic)).toThrow(CycleError);
  });

  it('ignores dependencies outside the node set for ordering', () => {
    expect(parallelLayers([{ id: 'x', dependencies: ['external'] }])).toEqual([['x']]);
    expect(findCycle([{ id: 'x', dependencies: ['x-external'] }])).toBeNull();
  });

  it('computes dependency readiness from task statuses', () => {
    const statuses = new Map<string, TaskStatus>([
      ['done', 'DONE'],
      ['running', 'RUNNING'],
      ['failed', 'FAILED'],
    ]);
    expect(dependencyState(['done'], statuses).ready).toBe(true);
    expect(dependencyState(['done', 'running'], statuses)).toMatchObject({ ready: false, waitingOn: ['running'] });
    expect(dependencyState(['failed', 'ghost'], statuses)).toMatchObject({
      ready: false,
      failed: ['failed'],
      missing: ['ghost'],
    });
  });
});
