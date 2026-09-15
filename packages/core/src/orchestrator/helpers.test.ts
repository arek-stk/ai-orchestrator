import { describe, expect, it } from 'vitest';
import { dashSlug, slugify } from '../domain/project';
import { branchNameFor } from './helpers';

// The regex chains used before dashSlug; kept as the behavioural reference on normal input.
const legacyBranchSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

const legacySlugify = (name: string) => {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'project';
};

const TITLES = [
  'Add CSV export for orders',
  '  --Fix: login (SSO) redirect!--  ',
  '',
  '---',
  '!!!',
  'Crème brûlée straße ÄÖÜ',
  'İstanbul KELVIN K sign',
  '🚀 launch\tday\nnow',
  'a_b-c.d 123',
  `${'x'.repeat(39)} tail`,
  `${'x'.repeat(40)}-tail`,
  `${'y'.repeat(63)} tail`,
  `${'ab '.repeat(30)}`,
];

describe('linear slugs', () => {
  it('match the previous regex chains on normal titles', () => {
    for (const title of TITLES) {
      expect(branchNameFor({ id: 'tsk_1', title })).toBe(`orchestrator/tsk_1${legacyBranchSlug(title) ? `-${legacyBranchSlug(title)}` : ''}`);
      expect(slugify(title)).toBe(legacySlugify(title));
      expect(dashSlug(title, 40)).toBe(legacyBranchSlug(title));
    }
    expect(branchNameFor({ id: 'tsk_1', title: 'Add CSV export for orders' })).toBe('orchestrator/tsk_1-add-csv-export-for-orders');
    expect(branchNameFor({ id: 'tsk_1', title: '!!!' })).toBe('orchestrator/tsk_1');
    expect(branchNameFor({ id: 'tsk_1', title: `${'x'.repeat(39)} tail` })).toBe(`orchestrator/tsk_1-${'x'.repeat(39)}`);
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
    expect(slugify('***')).toBe('project');
    expect(dashSlug('  --Hello,  World!--  ')).toBe('hello-world');
  });

  it('stay fast on hostile input with long dash and separator runs', () => {
    const hostile = [`${'-'.repeat(50_000)}x`, `x${'-'.repeat(50_000)}!`, `${'a-'.repeat(25_000)}!`, ' '.repeat(50_000), `${'-_'.repeat(25_000)}a`];
    const started = Date.now();
    const branches = hostile.map((title) => branchNameFor({ id: 'tsk_1', title }));
    const slugs = hostile.map((title) => slugify(title));
    expect(Date.now() - started).toBeLessThan(1_000);

    expect(branches[0]).toBe('orchestrator/tsk_1-x');
    expect(branches[1]).toBe('orchestrator/tsk_1-x');
    expect(branches[2]).toBe(`orchestrator/tsk_1-${'a-'.repeat(19)}a`);
    expect(branches[3]).toBe('orchestrator/tsk_1');
    expect(slugs[3]).toBe('project');
    expect(slugs[4]).toBe('a');
  });
});
